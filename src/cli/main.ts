#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { CONFIG_EXAMPLE, findProjectRoot, loadConfig, validateConfig } from "../core/config.js";
import { authorize, isTrusted } from "../core/trust.js";
import { executeProcess, ProcessError } from "../executors/process.js";
import { evaluateHook } from "../hooks/pre-tool-use.js";
import { installClaude, uninstallClaude } from "../integration/claude.js";
import { beginRun, finishRun, readStats, recordAttempt } from "../metrics/store.js";
import { codeWrite } from "../tasks/code-write.js";
import { delegate } from "../tasks/delegate.js";

const usage = `budger — delegate focused coding tasks to configured local CLIs

Commands:
  init [--scope project|user]  Create config, authorize it, and install Claude Code integration
  run <route> --question TEXT --paths FILE...
  bulk-read --question TEXT --paths FILE...
  code-write --spec TEXT --reference FILE... --target FILE
  config show|validate
  doctor
  executors test <name>
  stats [--last 7d]
  uninstall [--scope project|user]
`;

function options<Options extends ParseArgsOptionsConfig>(args: string[], definitions: Options) {
  return parseArgs({
    args,
    options: definitions,
    strict: true,
    allowPositionals: true,
  });
}

function print(value: unknown, json: boolean) {
  if (!json && typeof value === "string")
    process.stdout.write(value.endsWith("\n") ? value : `${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function stateFor(err: unknown): number {
  const message = (err as Error)?.message ?? String(err);

  return /timeout/i.test(message)
    ? 124
    : /cancelled|SIGINT/i.test(message)
      ? 130
      : /not authorized|Invalid configuration|Unknown route|Unknown command|references unknown|requires exactly|exceeds|escapes|At least one|Too many|not supported|already exists|duplicate fallback|fallback list|--scope|--spec|--target|--reference|--question|Usage:|Unexpected .* arguments|Unknown option/i.test(
            message,
          )
        ? 2
        : 1;
}

async function executableAvailable(command: string): Promise<boolean> {
  const candidates =
    isAbsolute(command) || command.includes("/") || command.includes("\\")
      ? [command]
      : (process.env.PATH ?? "")
          .split(delimiter)
          .flatMap((dir) =>
            process.platform === "win32"
              ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")].map((ext) =>
                  join(dir, command + ext),
                )
              : [join(dir, command)],
          );

  for (const path of candidates)
    try {
      await access(path, constants.X_OK);

      return true;
    } catch {
      /* Try the next PATH entry. */
    }

  return false;
}

async function assertLocalConfigPath(projectRoot: string, configPath: string): Promise<void> {
  const root = await realpath(projectRoot),
    directory = dirname(configPath);

  try {
    const stat = await lstat(directory);

    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("Refusing to initialize through a non-directory or symlink .budger path");

    const resolved = await realpath(directory),
      rel = relative(root, resolved);

    if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep))
      throw new Error("Refusing to initialize config outside the project root");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    const stat = await lstat(configPath);

    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error("Refusing to initialize a non-regular or symlink config file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function checkTrusted(cwd: string) {
  const loaded = await loadConfig(cwd);

  if (!(await isTrusted(loaded)))
    throw new Error(
      "Configuration is not authorized or has changed. Review it and run `budger init`.",
    );

  return loaded;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2),
    command = argv.shift();

  if (!command || command === "help" || command === "--help") {
    print(usage, false);

    return;
  }

  if (command === "init") {
    const parsed = options(argv, {
      "no-claude": { type: "boolean" },
      scope: { type: "string" },
      json: { type: "boolean" },
    });

    if (parsed.positionals.length)
      throw new Error(`Unexpected init arguments: ${parsed.positionals.join(" ")}`);

    const scope = parsed.values.scope ?? "project";

    if (scope !== "project" && scope !== "user")
      throw new Error("--scope must be either project or user");

    const root = await findProjectRoot(process.cwd()),
      configPath = join(root, ".budger", "config.yaml");
    await assertLocalConfigPath(root, configPath);
    await mkdir(join(root, ".budger"), { recursive: true });

    try {
      await readFile(configPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

      await writeFile(configPath, CONFIG_EXAMPLE, { flag: "wx", mode: 0o600 });
    }

    const loaded = await validateConfig(root);
    process.stderr.write(`Configuration: ${loaded.source ?? "built-in defaults"}\n`);

    for (const [name, executor] of Object.entries(loaded.config.executors)) {
      process.stderr.write(
        `Executor ${name}: ${executor.command} ${executor.args.map((x) => (x === "{prompt}" ? "[prompt]" : x)).join(" ")}\n`,
      );
      process.stderr.write(
        `  environment: inherit ${executor.env.inherit.join(", ") || "none"}; configured ${Object.keys(executor.env.values).join(", ") || "none"}\n`,
      );
    }

    for (const [name, route] of Object.entries(loaded.config.routes))
      process.stderr.write(`Route ${name}: ${[route.executor, ...route.fallback].join(" → ")}\n`);

    await authorize(loaded);

    if (!parsed.values["no-claude"]) await installClaude(root, scope);

    print(
      {
        initialized: true,
        projectRoot: root,
        claudeIntegration: !parsed.values["no-claude"],
        ...(parsed.values["no-claude"] ? {} : { claudeScope: scope }),
      },
      !!parsed.values.json,
    );

    return;
  }

  if (command === "uninstall") {
    const parsed = options(argv, { scope: { type: "string" } });

    if (parsed.positionals.length)
      throw new Error("Usage: budger uninstall [--scope project|user]");

    const scope = parsed.values.scope ?? "project";

    if (scope !== "project" && scope !== "user")
      throw new Error("--scope must be either project or user");

    await uninstallClaude(await findProjectRoot(process.cwd()), scope);
    print(`Budger Claude Code ${scope}-scope integration removed.`, false);

    return;
  }

  if (command === "config") {
    const sub = argv.shift();

    if (sub === "validate") {
      const parsed = options(argv, { json: { type: "boolean" } });

      if (parsed.positionals.length) throw new Error("Unexpected config validate arguments");

      const loaded = await validateConfig(process.cwd());
      print(
        {
          valid: true,
          source: loaded.source,
          executors: Object.keys(loaded.config.executors),
          routes: Object.keys(loaded.config.routes),
        },
        !!parsed.values.json,
      );

      return;
    }

    if (sub === "show") {
      const parsed = options(argv, { json: { type: "boolean" } });

      if (parsed.positionals.length) throw new Error("Unexpected config show arguments");

      const loaded = await loadConfig(process.cwd());
      const safe = structuredClone(loaded.config);

      for (const executor of Object.values(safe.executors))
        executor.env.values = Object.fromEntries(
          Object.keys(executor.env.values).map((key) => [key, "[hidden]"]),
        );

      print(
        { source: loaded.source, projectRoot: loaded.projectRoot, config: safe },
        !!parsed.values.json,
      );

      return;
    }

    throw new Error("Usage: budger config show|validate");
  }

  if (command === "hook" && argv.shift() === "pre-tool-use") {
    try {
      const loaded = await loadConfig(process.cwd());
      let size = 0;
      const chunks: Buffer[] = [];

      for await (const chunk of process.stdin) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;

        if (size > 262_144) return;

        chunks.push(buffer);
      }

      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));

      if (
        input?.hook_event_name !== "PreToolUse" ||
        !["Read", "Bash"].includes(input.tool_name) ||
        typeof input.cwd !== "string"
      )
        return;

      if (!(await isTrusted(loaded))) return;

      const decision = await evaluateHook(input, loaded);

      if (decision.action === "deny")
        process.stdout.write(
          `${JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: decision.reason,
            },
          })}\n`,
        );
    } catch {
      /* Hook failures fail open by contract. */
    }

    return;
  }

  if (command === "doctor") {
    const parsed = options(argv, { json: { type: "boolean" } });

    if (parsed.positionals.length) throw new Error("Unexpected doctor arguments");

    const loaded = await loadConfig(process.cwd());
    const checks = {
      node: process.version,
      bun: typeof Bun === "undefined" ? null : Bun.version,
      nodeSqlite: true,
      trusted: await isTrusted(loaded),
      executors: Object.fromEntries(
        await Promise.all(
          Object.entries(loaded.config.executors).map(async ([name, executor]) => [
            name,
            {
              command: executor.command,
              available: await executableAvailable(executor.command),
            } as const,
          ]),
        ),
      ),
    };
    print(checks, !!parsed.values.json);

    return;
  }

  if (command === "stats") {
    const parsed = options(argv, { last: { type: "string" }, json: { type: "boolean" } });

    if (parsed.positionals.length)
      throw new Error(`Unexpected stats arguments: ${parsed.positionals.join(" ")}`);

    const days = Number((parsed.values.last ?? "30d").replace(/d$/, ""));

    if (!Number.isInteger(days) || days <= 0)
      throw new Error("--last must be a positive number of days, such as 7d");

    print(await readStats(days), !!parsed.values.json);

    return;
  }

  if (command === "executors") {
    if (argv.shift() !== "test") throw new Error("Usage: budger executors test <name>");

    const parsed = options(argv, { json: { type: "boolean" } }),
      name = parsed.positionals[0];

    if (parsed.positionals.length !== 1 || !name)
      throw new Error("Usage: budger executors test <name>");

    if (process.env.BUDGER_ACTIVE === "1") throw new Error("Nested Budger delegation is disabled");

    const loaded = await checkTrusted(process.cwd()),
      executor = loaded.config.executors[name];

    if (!executor) throw new Error(`Unknown executor: ${name}`);

    const runId = randomUUID(),
      start = Date.now();
    let runStarted = false,
      recordingAttempts = false;

    try {
      await beginRun(loaded, "executors-test", runId);
      runStarted = recordingAttempts = true;
    } catch (error) {
      process.stderr.write(`Warning: metrics unavailable: ${(error as Error).message}\n`);
    }

    const controller = new AbortController(),
      abort = () => controller.abort();
    process.once("SIGINT", abort);

    try {
      const prompt = "Reply with exactly: BUDGER_OK";
      const result = await executeProcess({
        executor,
        prompt,
        cwd: loaded.projectRoot,
        signal: controller.signal,
      });

      if (recordingAttempts)
        try {
          await recordAttempt(loaded, runId, 1, {
            executor: name,
            durationMs: result.durationMs,
            status: "success",
            exitCode: result.exitCode,
            ...result.usage,
          });
        } catch (error) {
          process.stderr.write(
            `Warning: could not record attempt metrics: ${(error as Error).message}\n`,
          );
        }

      const passed = result.text.includes("BUDGER_OK");

      if (runStarted)
        try {
          await finishRun(loaded, runId, {
            status: passed ? "success" : "error",
            durationMs: Date.now() - start,
            executor: name,
            files: 0,
            inputBytes: Buffer.byteLength(prompt),
            resultBytes: Buffer.byteLength(result.text),
            estimateTokens: loaded.config.metrics.estimateTokens,
            estimateAvoided: false,
          });
        } catch (error) {
          process.stderr.write(`Warning: could not finish metrics: ${(error as Error).message}\n`);
        }

      print(
        { runId, executor: name, passed, durationMs: result.durationMs, text: result.text },
        !!parsed.values.json,
      );

      if (!passed) process.exitCode = 1;

      return;
    } catch (error) {
      if (recordingAttempts)
        try {
          await recordAttempt(loaded, runId, 1, {
            executor: name,
            durationMs: Date.now() - start,
            status: "error",
            ...(error instanceof ProcessError
              ? {
                  errorKind: error.kind,
                  ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
                  ...(error.signal === undefined ? {} : { signal: error.signal }),
                }
              : {}),
          });
        } catch {
          /* The execution error remains primary. */
        }

      if (runStarted)
        try {
          await finishRun(loaded, runId, {
            status: "error",
            durationMs: Date.now() - start,
            estimateTokens: false,
          });
        } catch {
          /* The execution error remains primary. */
        }

      throw new Error(`${(error as Error).message ?? String(error)} (run ${runId})`, {
        cause: error,
      });
    } finally {
      process.removeListener("SIGINT", abort);
    }
  }

  if (command === "bulk-read" || command === "run") {
    const route = command === "run" ? argv.shift() : "bulk-read";

    if (!route) throw new Error("Route name required");

    const parsed = options(argv, {
      question: { type: "string" },
      paths: { type: "string", multiple: true },
      json: { type: "boolean" },
    });

    if (parsed.positionals.length)
      throw new Error(`Unexpected arguments: ${parsed.positionals.join(" ")}`);

    const question = parsed.values.question;

    if (!question) throw new Error("--question is required");

    const loaded = await checkTrusted(process.cwd());
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    const start = Date.now(),
      runId = randomUUID();
    let attemptNo = 0,
      runStarted = false,
      recordingAttempts = false;

    try {
      await beginRun(loaded, route, runId);
      runStarted = recordingAttempts = true;
    } catch (error) {
      process.stderr.write(`Warning: metrics unavailable: ${(error as Error).message}\n`);
    }

    try {
      const result = await delegate(
        loaded,
        route,
        question,
        parsed.values.paths ?? [],
        controller.signal,
        async (attempt) => {
          attemptNo++;

          if (recordingAttempts)
            try {
              await recordAttempt(loaded, runId, attemptNo, attempt);
            } catch (error) {
              process.stderr.write(
                `Warning: could not record attempt metrics: ${(error as Error).message}\n`,
              );
              recordingAttempts = false;
            }
        },
      );

      if (runStarted)
        try {
          await finishRun(loaded, runId, {
            status: "success",
            executor: result.executor,
            durationMs: Date.now() - start,
            files: result.files,
            inputBytes: result.inputBytes,
            resultBytes: Buffer.byteLength(result.text),
            estimateTokens: loaded.config.metrics.estimateTokens,
          });
        } catch (error) {
          process.stderr.write(`Warning: could not finish metrics: ${(error as Error).message}\n`);
        }

      print(parsed.values.json ? { runId, ...result } : result.text, !!parsed.values.json);

      return;
    } catch (error) {
      if (runStarted)
        try {
          await finishRun(loaded, runId, {
            status: "error",
            durationMs: Date.now() - start,
            estimateTokens: false,
          });
        } catch (metricError) {
          process.stderr.write(
            `Warning: could not finish metrics: ${(metricError as Error).message}\n`,
          );
        }

      throw new Error(`${(error as Error).message ?? String(error)} (run ${runId})`, {
        cause: error,
      });
    } finally {
      process.removeListener("SIGINT", abort);
    }
  }

  if (command === "code-write") {
    const parsed = options(argv, {
      spec: { type: "string" },
      reference: { type: "string", multiple: true },
      target: { type: "string" },
      json: { type: "boolean" },
    });

    if (parsed.positionals.length)
      throw new Error(`Unexpected code-write arguments: ${parsed.positionals.join(" ")}`);

    const loaded = await checkTrusted(process.cwd()),
      runId = randomUUID(),
      start = Date.now();
    let attemptNo = 0,
      runStarted = false,
      recordingAttempts = false;

    try {
      await beginRun(loaded, "code-write", runId);
      runStarted = recordingAttempts = true;
    } catch (error) {
      process.stderr.write(`Warning: metrics unavailable: ${(error as Error).message}\n`);
    }

    const controller = new AbortController(),
      abort = () => controller.abort();
    process.once("SIGINT", abort);

    try {
      const result = await codeWrite(
        loaded,
        parsed.values.spec ?? "",
        parsed.values.reference ?? [],
        parsed.values.target ?? "",
        async (attempt) => {
          attemptNo++;

          if (recordingAttempts)
            try {
              await recordAttempt(loaded, runId, attemptNo, attempt);
            } catch (error) {
              process.stderr.write(
                `Warning: could not record attempt metrics: ${(error as Error).message}\n`,
              );
              recordingAttempts = false;
            }
        },
        controller.signal,
      );

      if (runStarted)
        try {
          await finishRun(loaded, runId, {
            status: "success",
            executor: result.executor,
            durationMs: Date.now() - start,
            files: result.files,
            inputBytes: result.inputBytes,
            resultBytes: result.bytes,
            estimateTokens: loaded.config.metrics.estimateTokens,
            estimateAvoided: false,
          });
        } catch (error) {
          process.stderr.write(`Warning: could not finish metrics: ${(error as Error).message}\n`);
        }

      print(
        parsed.values.json
          ? { runId, path: result.path, bytes: result.bytes, lines: result.lines }
          : { path: result.path, bytes: result.bytes, lines: result.lines },
        !!parsed.values.json,
      );

      return;
    } catch (error) {
      if (runStarted)
        try {
          await finishRun(loaded, runId, {
            status: "error",
            durationMs: Date.now() - start,
            estimateTokens: false,
          });
        } catch (metricError) {
          process.stderr.write(
            `Warning: could not finish metrics: ${(metricError as Error).message}\n`,
          );
        }

      throw new Error(`${(error as Error).message ?? String(error)} (run ${runId})`, {
        cause: error,
      });
    } finally {
      process.removeListener("SIGINT", abort);
    }
  }

  throw new Error(`Unknown command: ${command}\n${usage}`);
}

main().catch((error: unknown) => {
  const message = (error as Error).message ?? String(error);
  process.stderr.write(`budger: ${message}\n`);
  process.exitCode = stateFor(error);
});
