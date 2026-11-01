import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { findProjectRoot, loadConfig } from "../../src/core/config.js";
import { executeProcess, type ProcessError } from "../../src/executors/process.js";
import { evaluateHook } from "../../src/hooks/pre-tool-use.js";
import { beginRun, finishRun, readStats, recordAttempt } from "../../src/metrics/store.js";
import { codeWrite } from "../../src/tasks/code-write.js";
import { delegate } from "../../src/tasks/delegate.js";

const roots: string[] = [];
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture value");
  return value;
}
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "budger-test-"));
  roots.push(path);
  await mkdir(join(path, ".budger"));
  await writeFile(join(path, ".gitignore"), "");
  return path;
}
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});
function config(
  command = process.execPath,
  args = [
    "-e",
    "let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>process.stdout.write(s))",
  ],
) {
  return `version: 1\nexecutors:\n  local:\n    command: ${JSON.stringify(command)}\n    args: ${JSON.stringify(args)}\n    input: { mode: stdin }\nroutes:\n  bulk-read:\n    executor: local\n    instructions: Answer briefly.\n  code-write:\n    executor: local\n    instructions: Return the supplied content.\n    limits: { maxResultBytes: 10000 }\n`;
}

describe("configuration and delegation", () => {
  test("loads an unconfigured project for doctor and init", async () => {
    const root = await fixture();
    const loaded = await loadConfig(root);
    expect(loaded.config.executors).toEqual({});
    expect(loaded.config.routes).toEqual({});
    expect(loaded.source).toBeNull();
  });

  test("finds the Git root when init starts below it", async () => {
    const root = await fixture(),
      nested = join(root, "src", "nested");
    await mkdir(nested, { recursive: true });
    await mkdir(join(root, ".git"));
    expect(await findProjectRoot(nested)).toBe(root);
  });

  test("init can create Budger config in a selected monorepo subproject", async () => {
    const root = await mkdtemp(join(tmpdir(), "budger-monorepo-test-"));
    roots.push(root);
    const app = join(root, "apps", "frontend"),
      cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url)),
      env = {
        ...process.env,
        XDG_CONFIG_HOME: join(root, "xdg-config"),
        XDG_STATE_HOME: join(root, "xdg-state"),
      };
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(app, { recursive: true });

    const init = spawnSync(
      process.execPath,
      [cli, "init", "--no-claude", "--project-root", "apps/frontend"],
      { cwd: root, env, encoding: "utf8" },
    );
    expect(init.status).toBe(0);
    await readFile(join(app, ".budger", "config.yaml"));

    const show = spawnSync(process.execPath, [cli, "config", "show", "--json"], {
      cwd: app,
      env,
      encoding: "utf8",
    });
    expect(show.status).toBe(0);
    expect(JSON.parse(show.stdout).projectRoot).toBe(await realpath(app));

    await writeFile(join(app, ".budger", "config.yaml"), config());
    await mkdir(join(app, "src"));
    await writeFile(join(app, "src", "entry.ts"), "export const app = true;\n");
    const result = await delegate(await loadConfig(app), "bulk-read", "Summarize", [
      "src/entry.ts",
    ]);
    expect(result.text).toContain('"path":"src/entry.ts"');
    expect(result.text).toContain("export const app = true");
  });

  test("merges route names but replaces each project definition and merges hook fields", async () => {
    const root = await fixture(),
      previous = process.env.XDG_CONFIG_HOME,
      global = join(root, "global");
    process.env.XDG_CONFIG_HOME = global;
    try {
      await mkdir(join(global, "budger"), { recursive: true });
      await writeFile(
        join(global, "budger", "config.yaml"),
        `version: 1\nexecutors:\n  local: { command: node, args: [global], timeoutMs: 50 }\nroutes:\n  bulk-read: { executor: local, instructions: global }\nhooks:\n  read: { enabled: false, minLines: 100 }\n`,
      );
      await writeFile(
        join(root, ".budger", "config.yaml"),
        `version: 1\nexecutors:\n  local: { command: node, args: [project] }\nroutes:\n  bulk-read: { executor: local, instructions: project }\nhooks:\n  read: { minLines: 200 }\n`,
      );
      const loaded = await loadConfig(root);
      expect(loaded.config.executors.local?.args).toEqual(["project"]);
      expect(loaded.config.executors.local?.timeoutMs).toBe(120_000);
      expect(loaded.config.routes["bulk-read"]?.instructions).toBe("project");
      expect(loaded.config.hooks.read.enabled).toBe(false);
      expect(loaded.config.hooks.read.minLines).toBe(200);
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
    }
  });

  test("validates routes and rejects unknown executor references", async () => {
    const root = await fixture();
    await writeFile(join(root, ".budger", "config.yaml"), config());
    expect((await loadConfig(root)).config.routes["bulk-read"]?.executor).toBe("local");
    await writeFile(
      join(root, ".budger", "config.yaml"),
      "version: 1\nroutes:\n  bulk-read: { executor: missing }\n",
    );
    await expect(loadConfig(root)).rejects.toThrow("unknown executor");
  });

  test("rejects paths escaping project and delegates selected files", async () => {
    const root = await fixture();
    await writeFile(join(root, ".budger", "config.yaml"), config());
    await writeFile(join(root, "source.txt"), "hello");
    const loaded = await loadConfig(root);
    const response = await delegate(loaded, "bulk-read", "Summarize", ["source.txt"]);
    expect(response.text).toContain("source.txt");
    expect(response.attempts).toBe(1);
    const outside = join(dirname(root), "budger-outside-secret.txt");
    await writeFile(outside, "secret");
    try {
      await expect(
        delegate(loaded, "bulk-read", "read", [relative(root, outside)]),
      ).rejects.toThrow("escapes");
    } finally {
      await rm(outside, { force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "rejects symlinks that resolve outside the project",
    async () => {
      const root = await fixture(),
        outside = join(root, "..", "budger-symlink-target.txt");
      await writeFile(outside, "private");
      await symlink(outside, join(root, "outside.txt"));
      await writeFile(join(root, ".budger", "config.yaml"), config());
      try {
        await expect(
          delegate(await loadConfig(root), "bulk-read", "read", ["outside.txt"]),
        ).rejects.toThrow("escapes");
      } finally {
        await rm(outside, { force: true });
      }
    },
  );

  test("parses JSONL response and enforces success event", async () => {
    const root = await fixture();
    await writeFile(
      join(root, ".budger", "config.yaml"),
      `version: 1\nexecutors:\n  local:\n    command: ${JSON.stringify(process.execPath)}\n    args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'answer'}})+'\\\\n'+JSON.stringify({type:'turn.completed',usage:{input:12,output:4,cached:2,reasoning:1},cost:0.01})+'\\\\n'))"]\n    response:\n      format: jsonl\n      text: { match: { /type: item.completed, /item/type: agent_message }, pointer: /item/text }\n      success: { match: { /type: turn.completed } }\n      usage: { match: { /type: turn.completed }, fields: { inputTokens: /usage/input, outputTokens: /usage/output } }\n      cost: { match: { /type: turn.completed }, amount: /cost, currency: USD }\nroutes:\n  bulk-read: { executor: local }\n`,
    );
    const loaded = await loadConfig(root);
    const result = await executeProcess({
      executor: required(loaded.config.executors.local),
      prompt: "question",
      cwd: root,
    });
    expect(result.text).toBe("answer");
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 4,
      reportedCost: 0.01,
      currency: "USD",
    });
  });

  test("runs configured fallbacks sequentially after executor failure", async () => {
    const root = await fixture();
    await writeFile(
      join(root, ".budger", "config.yaml"),
      config(process.execPath, ["-e", "process.exit(7)"]),
    );
    await writeFile(join(root, "input.txt"), "context");
    const loaded = await loadConfig(root);
    const localExecutor = required(loaded.config.executors.local);
    const bulkReadRoute = required(loaded.config.routes["bulk-read"]);
    loaded.config.executors.backup = {
      ...localExecutor,
      args: [
        "-e",
        "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('fallback'))",
      ],
    };
    bulkReadRoute.fallback = ["backup"];
    const attempts: string[] = [];
    const result = await delegate(
      loaded,
      "bulk-read",
      "question",
      ["input.txt"],
      undefined,
      (attempt) => {
        attempts.push(`${attempt.executor}:${attempt.status}`);
      },
    );
    expect(result.text).toBe("fallback");
    expect(result.attempts).toBe(2);
    expect(attempts).toEqual(["local:error", "backup:success"]);
  });
});

describe("file and hook boundaries", () => {
  test("code-write creates once and does not replace existing targets", async () => {
    const root = await fixture();
    await writeFile(
      join(root, ".budger", "config.yaml"),
      config(process.execPath, [
        "-e",
        "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('```ts\\nconst answer = 42;\\n```'))",
      ]),
    );
    await writeFile(join(root, "reference.ts"), "export const example = 1;\n");
    const loaded = await loadConfig(root);
    const output = await codeWrite(loaded, "generate", ["reference.ts"], "created.ts");
    expect(await readFile(join(root, "created.ts"), "utf8")).toBe("const answer = 42;");
    expect(output.lines).toBe(1);
    await expect(codeWrite(loaded, "again", ["reference.ts"], "created.ts")).rejects.toThrow(
      "already exists",
    );
  });

  test("Read hook blocks large reads and allows bounded ones; Bash leaves pipes alone", async () => {
    const root = await fixture();
    await writeFile(
      join(root, ".budger", "config.yaml"),
      "version: 1\nexecutors:\n  local: { command: node }\nroutes:\n  bulk-read: { executor: local }\nhooks:\n  read: { minLines: 350 }\n  bash: { minLines: 350 }\n",
    );
    await writeFile(
      join(root, "large.txt"),
      Array.from({ length: 400 }, (_, i) => String(i + 1)).join("\n"),
    );
    const loaded = await loadConfig(root);
    expect(
      (
        await evaluateHook(
          { tool_name: "Read", cwd: root, tool_input: { file_path: "large.txt" } },
          loaded,
        )
      ).action,
    ).toBe("deny");
    expect(
      (
        await evaluateHook(
          { tool_name: "Read", cwd: root, tool_input: { file_path: "large.txt", limit: 3 } },
          loaded,
        )
      ).action,
    ).toBe("pass");
    expect(
      (
        await evaluateHook(
          { tool_name: "Bash", cwd: root, tool_input: { command: "cat large.txt | wc -l" } },
          loaded,
        )
      ).action,
    ).toBe("pass");
    expect(
      (
        await evaluateHook(
          { tool_name: "Bash", cwd: root, tool_input: { command: "head -100 large.txt" } },
          loaded,
        )
      ).action,
    ).toBe("pass");
    expect(
      (
        await evaluateHook(
          { tool_name: "Bash", cwd: root, tool_input: { command: "head -1000 large.txt" } },
          loaded,
        )
      ).action,
    ).toBe("deny");
    expect(
      (
        await evaluateHook(
          { tool_name: "Bash", cwd: root, tool_input: { command: "head -n -20 large.txt" } },
          loaded,
        )
      ).action,
    ).toBe("deny");
    expect(
      (
        await evaluateHook(
          { tool_name: "Bash", cwd: root, tool_input: { command: "tail -n +20 large.txt" } },
          loaded,
        )
      ).action,
    ).toBe("deny");
  });

  test("kills a timed out executor and reports timeout", async () => {
    const root = await fixture();
    await writeFile(
      join(root, ".budger", "config.yaml"),
      config(process.execPath, ["-e", "setTimeout(()=>{},10000)"]),
    );
    const loaded = await loadConfig(root),
      executor = { ...required(loaded.config.executors.local), timeoutMs: 50 };
    await expect(executeProcess({ executor, prompt: "", cwd: root })).rejects.toMatchObject({
      kind: "timeout",
    } satisfies Partial<ProcessError>);
  });

  test.skipIf(process.platform === "win32")(
    "terminates descendant processes on timeout",
    async () => {
      const root = await fixture(),
        pidFile = join(root, "child.pid");
      const script = `const child=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setTimeout(()=>{},10000)`;
      await writeFile(
        join(root, ".budger", "config.yaml"),
        config(process.execPath, ["-e", script]),
      );
      const loaded = await loadConfig(root),
        executor = { ...required(loaded.config.executors.local), timeoutMs: 150 };
      await expect(executeProcess({ executor, prompt: "", cwd: root })).rejects.toMatchObject({
        kind: "timeout",
      });
      const pid = Number(await readFile(pidFile, "utf8"));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    },
  );

  test("stores run and attempt metadata without source or prompt contents", async () => {
    const root = await fixture(),
      previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(root, "state");
    try {
      await writeFile(join(root, ".budger", "config.yaml"), config());
      const loaded = await loadConfig(root),
        runId = "11111111-1111-4111-8111-111111111111";
      await beginRun(loaded, "bulk-read", runId);
      await recordAttempt(loaded, runId, 1, {
        executor: "local",
        durationMs: 10,
        status: "success",
        inputTokens: 3,
        reportedCost: 0.03,
        currency: "USD",
      });
      await finishRun(loaded, runId, {
        status: "success",
        durationMs: 10,
        executor: "local",
        files: 1,
        inputBytes: 100,
        resultBytes: 20,
        estimateTokens: true,
      });
      const stats = await readStats(7);
      expect(stats.runs).toBe(1);
      expect(stats.estimatedInputTokens).toBe(25);
      expect(stats.potentialAvoidedTokens).toBe(20);
      expect(stats.reportedInputTokens).toBe(3);
      expect(stats.costs).toEqual([{ currency: "USD", source: "reported", amount: 0.03 }]);
      const db = await readFile(join(root, "state", "budger", "metrics.sqlite"));
      expect(db.includes(Buffer.from("source.txt"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
    }
  });
});
