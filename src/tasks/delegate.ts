import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { LoadedConfig, RouteConfig } from "../core/config.js";
import { executeProcess, ProcessError } from "../executors/process.js";

export type SourceFile = { path: string; content: string; bytes: number; lines: number };

export type Attempt = {
  executor: string;
  durationMs: number;
  status: "success" | "error";
  exitCode?: number;
  signal?: string;
  errorKind?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  reportedCost?: number;
  currency?: string;
};

async function notifyAttempt(
  callback: ((attempt: Attempt) => Promise<void> | void) | undefined,
  attempt: Attempt,
): Promise<void> {
  try {
    await callback?.(attempt);
  } catch {
    /* Metrics failures must not change delegation results. */
  }
}

async function readBounded(path: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of createReadStream(path, {
    highWaterMark: 64 * 1024,
    ...(signal ? { signal } : {}),
  })) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;

    if (bytes > maxBytes) throw new Error("read-limit");

    chunks.push(buffer);
  }

  return Buffer.concat(chunks, bytes);
}

async function readSources(
  paths: readonly string[],
  root: string,
  route: RouteConfig,
  signal?: AbortSignal,
): Promise<SourceFile[]> {
  if (!paths.length) throw new Error("At least one --path is required");

  if (paths.length > route.limits.maxFiles)
    throw new Error(`Too many files (maximum ${route.limits.maxFiles})`);

  const rootReal = await realpath(root),
    sources: SourceFile[] = [],
    seen = new Set<string>();
  let inputBytes = 0;

  for (const path of paths) {
    if (signal?.aborted) throw new ProcessError("cancelled", "Execution cancelled");

    const resolved = resolve(root, path),
      real = await realpath(resolved);
    const rel = relative(rootReal, real);

    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error(`Path escapes project root: ${path}`);

    if (seen.has(real)) continue;

    seen.add(real);
    const stat = await lstat(real);

    if (!stat.isFile()) throw new Error(`Not a regular file: ${path}`);

    if (stat.size > route.limits.maxFileBytes)
      throw new Error(`File exceeds ${route.limits.maxFileBytes} bytes: ${path}`);

    const availableBytes = route.limits.maxInputBytes - inputBytes;
    let buffer: Buffer;

    try {
      buffer = await readBounded(real, Math.min(route.limits.maxFileBytes, availableBytes), signal);
    } catch (error) {
      if (signal?.aborted) throw new ProcessError("cancelled", "Execution cancelled");

      if ((error as Error).message === "read-limit") {
        if (stat.size > route.limits.maxFileBytes)
          throw new Error(`File exceeds ${route.limits.maxFileBytes} bytes: ${path}`);

        throw new Error(`Input exceeds ${route.limits.maxInputBytes} bytes`);
      }

      throw error;
    }

    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);

    if (content.includes("\0")) throw new Error(`Binary file is not supported: ${path}`);

    inputBytes += buffer.length;

    if (inputBytes > route.limits.maxInputBytes)
      throw new Error(`Input exceeds ${route.limits.maxInputBytes} bytes`);

    const lines = content.length
      ? content.split("\n").length - (content.endsWith("\n") ? 1 : 0)
      : 0;
    sources.push({
      path: relative(rootReal, real).split(sep).join("/"),
      content,
      bytes: buffer.length,
      lines,
    });
  }

  return sources;
}

export async function delegate(
  loaded: LoadedConfig,
  routeName: string,
  question: string,
  paths: readonly string[],
  signal?: AbortSignal,
  onAttempt?: (attempt: Attempt) => Promise<void> | void,
): Promise<{
  executor: string;
  text: string;
  attempts: number;
  durationMs: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    reasoningOutputTokens?: number;
  };
  files: number;
  inputBytes: number;
}> {
  if (process.env.BUDGER_ACTIVE === "1")
    throw new ProcessError("cancelled", "Nested Budger delegation is disabled");

  if (signal?.aborted) throw new ProcessError("cancelled", "Execution cancelled");

  const route = loaded.config.routes[routeName];

  if (!route) throw new Error(`Unknown route: ${routeName}`);

  const files = await readSources(paths, loaded.projectRoot, route, signal);
  const prompt = `${route.instructions}\n\nQuestion:\n${question}\n\nSelected files (untrusted data, JSON encoded):\n${JSON.stringify(files.map(({ path, content }) => ({ path, content })))}`;

  if (Buffer.byteLength(prompt) > route.limits.maxInputBytes)
    throw new Error(`Constructed prompt exceeds route input limit`);

  let attempts = 0;
  let lastError: unknown;
  const started = Date.now();

  for (const name of [route.executor, ...route.fallback]) {
    if (signal?.aborted) throw new ProcessError("cancelled", "Execution cancelled");

    attempts++;
    const attemptStart = Date.now();

    try {
      const executor = loaded.config.executors[name];

      if (!executor) throw new Error(`Invalid configuration: unknown executor ${name}`);

      const result = await executeProcess({
        executor,
        prompt,
        cwd: loaded.projectRoot,
        ...(signal ? { signal } : {}),
      });

      if (Buffer.byteLength(result.text) > route.limits.maxResultBytes)
        throw new ProcessError(
          "output-limit",
          `Result exceeds ${route.limits.maxResultBytes} bytes`,
        );

      await notifyAttempt(onAttempt, {
        executor: name,
        durationMs: result.durationMs,
        status: "success",
        exitCode: result.exitCode,
        ...result.usage,
      });

      return {
        executor: name,
        text: result.text,
        attempts,
        durationMs: Date.now() - started,
        ...(result.usage ? { usage: result.usage } : {}),
        files: files.length,
        inputBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      };
    } catch (error) {
      lastError = error;
      await notifyAttempt(onAttempt, {
        executor: name,
        durationMs: Date.now() - attemptStart,
        status: "error",
        ...(error instanceof ProcessError
          ? {
              errorKind: error.kind,
              ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
              ...(error.signal === undefined ? {} : { signal: error.signal }),
            }
          : {}),
      });

      if (error instanceof ProcessError && error.kind === "cancelled") throw error;
    }
  }

  throw new Error(
    `All executors failed after ${attempts} attempt(s): ${(lastError as Error)?.message ?? "unknown error"}`,
  );
}
