import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutorConfig } from "../core/config.js";

export type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  reportedCost?: number;
  currency?: string;
};

export type ExecutionResult = {
  text: string;
  durationMs: number;
  exitCode: number;
  stdoutBytes: number;
  stderrBytes: number;
  usage?: Usage;
};

export class ProcessError extends Error {
  constructor(
    public readonly kind: "spawn" | "timeout" | "cancelled" | "exit" | "output-limit" | "response",
    message: string,
    public readonly exitCode?: number,
    public readonly signal?: string,
  ) {
    super(message);
  }
}

function pointer(value: unknown, path: string): unknown {
  if (path === "") return value;

  let current = value;

  for (const raw of path.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");

    if (current === null || typeof current !== "object") return undefined;

    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

function matches(value: unknown, expected?: Record<string, unknown>): boolean {
  return (
    !!expected &&
    Object.entries(expected).every(([key, wanted]) => Object.is(pointer(value, key), wanted))
  );
}

function parseResponse(raw: string, executor: ExecutorConfig): { text: string; usage?: Usage } {
  const spec = executor.response;

  if (spec.format === "text") return { text: raw };

  let records: unknown[];

  try {
    records =
      spec.format === "jsonl"
        ? raw
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [JSON.parse(raw)];
  } catch {
    throw new ProcessError("response", `Executor returned invalid ${spec.format.toUpperCase()}`);
  }

  if (spec.failure && records.some((record) => matches(record, spec.failure?.match)))
    throw new ProcessError("response", "Executor reported a failed turn");

  const success = spec.success;

  if (success && !records.some((record) => matches(record, success.match)))
    throw new ProcessError("response", "Executor response did not contain a success event");

  const errorPointer = spec.errorPointer;

  if (errorPointer && records.some((record) => pointer(record, errorPointer) !== undefined))
    throw new ProcessError("response", "Executor response contained an error");

  const candidates = records
    .filter((record) => !spec.text.match || matches(record, spec.text.match))
    .map((record) => pointer(record, spec.text.pointer ?? ""));
  const strings = candidates.filter(
    (candidate): candidate is string => typeof candidate === "string",
  );
  const text = spec.text.take === "concat" ? strings.join("\n") : (strings.at(-1) ?? "");
  let usage: Usage | undefined;

  if (spec.usage) {
    const record = records.find((item) => !spec.usage?.match || matches(item, spec.usage.match));

    if (record !== undefined) {
      const fields = [
        ["inputTokens", "inputTokens"],
        ["outputTokens", "outputTokens"],
        ["cachedInputTokens", "cachedInputTokens"],
        ["reasoningOutputTokens", "reasoningOutputTokens"],
      ] as const;
      const result: Usage = {};

      for (const [key, configKey] of fields) {
        const path = spec.usage.fields[configKey];

        if (!path) continue;

        const v = pointer(record, path);

        if (v === undefined) continue;

        if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
          throw new ProcessError(
            "response",
            `Executor usage field ${path} must be a non-negative integer`,
          );

        result[key] = v;
      }

      if (Object.keys(result).length) usage = result;
    }
  }

  if (spec.cost) {
    const record = [...records]
      .reverse()
      .find((item) => !spec.cost?.match || matches(item, spec.cost.match));

    if (record !== undefined) {
      const amount = pointer(record, spec.cost.amount);

      if (amount !== undefined) {
        if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0)
          throw new ProcessError(
            "response",
            `Executor cost field ${spec.cost.amount} must be a non-negative number`,
          );

        usage ??= {};
        usage.reportedCost = amount;
        usage.currency = spec.cost.currency;
      }
    }
  }

  return usage ? { text, usage } : { text };
}

export async function executeProcess(input: {
  executor: ExecutorConfig;
  prompt: string;
  cwd: string;
  signal?: AbortSignal;
}): Promise<ExecutionResult> {
  const { executor, prompt, cwd } = input;

  if (input.signal?.aborted) throw new ProcessError("cancelled", "Execution cancelled");

  if (executor.input.mode === "argument") {
    const count = executor.args.filter((arg) => arg === "{prompt}").length;

    if (count !== 1)
      throw new ProcessError(
        "response",
        "Argument input requires exactly one complete {prompt} argument",
      );

    if (Buffer.byteLength(prompt) > executor.input.maxBytes)
      throw new ProcessError("output-limit", "Prompt exceeds executor argument input limit");
  } else if (executor.args.some((arg) => arg.includes("{prompt}")))
    throw new ProcessError("response", "{prompt} requires input.mode: argument");

  const tempDir = await mkdtemp(join(tmpdir(), "budger-"));
  const expand = (value: string) =>
    value.replaceAll("{projectRoot}", cwd).replaceAll("{tempDir}", tempDir);
  const args = executor.args.map((arg) => (arg === "{prompt}" ? prompt : expand(arg)));
  const env: NodeJS.ProcessEnv = {};

  for (const key of executor.env.inherit)
    if (process.env[key] !== undefined) env[key] = process.env[key];

  Object.assign(env, executor.env.values, { BUDGER_ACTIVE: "1", NO_COLOR: "1" });
  const processCwd = expand(executor.cwd);
  const start = Date.now();

  try {
    const result = await new Promise<{
      stdout: Buffer;
      stderr: Buffer;
      code: number;
      signal: string | null;
    }>((resolvePromise, reject) => {
      let child: ChildProcessWithoutNullStreams;

      try {
        child = spawn(executor.command, args, {
          cwd: processCwd,
          env,
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"] as const,
        });
      } catch (error) {
        reject(
          new ProcessError(
            "spawn",
            `Could not start ${executor.command}: ${(error as Error).message}`,
          ),
        );

        return;
      }

      const out: Buffer[] = [],
        err: Buffer[] = [];
      let outSize = 0,
        errSize = 0,
        settled = false,
        pendingError: ProcessError | undefined,
        forceTimer: NodeJS.Timeout | undefined;
      const finishError = (error: ProcessError) => {
        if (settled || pendingError) return;

        pendingError = error;
        const childPid = child.pid;

        if (process.platform === "win32" && childPid) {
          const killer = spawn("taskkill", ["/pid", String(childPid), "/t", "/f"], {
            shell: false,
            stdio: "ignore",
          });
          killer.on("error", () => child.kill("SIGKILL"));
        } else if (childPid) {
          try {
            process.kill(-childPid, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }

          forceTimer = setTimeout(() => {
            try {
              process.kill(-childPid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }, 150);
          forceTimer.unref();
        } else child.kill("SIGKILL");
      };
      const timer = setTimeout(
        () =>
          finishError(
            new ProcessError("timeout", `Executor timed out after ${executor.timeoutMs}ms`),
          ),
        executor.timeoutMs,
      );
      const abort = () => finishError(new ProcessError("cancelled", "Execution cancelled"));
      input.signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        outSize += chunk.length;

        if (outSize > executor.maxStdoutBytes)
          finishError(
            new ProcessError("output-limit", "Executor stdout exceeded configured limit"),
          );
        else out.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        errSize += chunk.length;

        if (errSize > executor.maxStderrBytes)
          finishError(
            new ProcessError("output-limit", "Executor stderr exceeded configured limit"),
          );
        else err.push(chunk);
      });
      child.on("error", (error: Error) =>
        finishError(
          new ProcessError("spawn", `Could not start ${executor.command}: ${error.message}`),
        ),
      );
      child.stdin.on("error", () => {});
      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timer);

        if (forceTimer) clearTimeout(forceTimer);

        input.signal?.removeEventListener("abort", abort);
        settled = true;

        if (pendingError)
          reject(
            new ProcessError(
              pendingError.kind,
              pendingError.message,
              code ?? undefined,
              signal ?? undefined,
            ),
          );
        else
          resolvePromise({
            stdout: Buffer.concat(out),
            stderr: Buffer.concat(err),
            code: code ?? 1,
            signal,
          });
      });

      if (executor.input.mode === "stdin") child.stdin.end(prompt);
      else child.stdin.end();
    });

    if (result.code !== 0)
      throw new ProcessError(
        "exit",
        result.signal
          ? `Executor terminated by ${result.signal}`
          : `Executor exited with code ${result.code}${result.stderr.length ? `: ${result.stderr.toString("utf8").trim().slice(0, 500)}` : ""}`,
        result.code,
        result.signal ?? undefined,
      );

    let stdout: string;

    try {
      stdout = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
    } catch {
      throw new ProcessError("response", "Executor stdout is not valid UTF-8");
    }

    const parsed = parseResponse(stdout, executor);

    if (!parsed.text.trim())
      throw new ProcessError("response", "Executor returned an empty response");

    return {
      ...parsed,
      durationMs: Date.now() - start,
      exitCode: result.code,
      stdoutBytes: result.stdout.length,
      stderrBytes: result.stderr.length,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
