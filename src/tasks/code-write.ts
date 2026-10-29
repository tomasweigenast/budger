import { link, lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { LoadedConfig } from "../core/config.js";
import { ProcessError } from "../executors/process.js";
import { type Attempt, delegate } from "./delegate.js";

export async function codeWrite(
  loaded: LoadedConfig,
  spec: string,
  references: string[],
  target: string,
  onAttempt?: (attempt: Attempt) => Promise<void> | void,
  signal?: AbortSignal,
): Promise<{
  path: string;
  bytes: number;
  lines: number;
  executor: string;
  durationMs: number;
  files: number;
  inputBytes: number;
}> {
  if (!spec.trim() || !references.length || !target)
    throw new Error("code-write requires --spec, at least one --reference, and --target");

  const lexicalDest = resolve(loaded.projectRoot, target),
    parent = dirname(lexicalDest),
    root = await realpath(loaded.projectRoot),
    realParent = await realpath(parent);
  const relParent = relative(root, realParent);

  if (relParent === ".." || relParent.startsWith(`..${sep}`) || isAbsolute(relParent))
    throw new Error("Target directory escapes project root");

  const dest = join(realParent, basename(lexicalDest));

  try {
    await lstat(dest);

    throw new Error(`Target already exists: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const result = await delegate(loaded, "code-write", spec, references, signal, onAttempt);

  if (signal?.aborted) throw new ProcessError("cancelled", "Execution cancelled");

  let content = result.text;
  const fence = content.match(/^[ \t\r\n]*```[^\r\n]*\r?\n([\s\S]*?)\r?\n```[ \t\r\n]*$/);

  if (fence?.[1] !== undefined) content = fence[1];

  const route = loaded.config.routes["code-write"];

  if (!route) throw new Error("Unknown route: code-write");

  const bytes = Buffer.byteLength(content);

  if (bytes > route.limits.maxResultBytes)
    throw new Error(`Generated file exceeds ${route.limits.maxResultBytes} bytes`);

  const tempDir = await mkdtemp(join(realParent, ".budger-"));
  const temp = join(tempDir, basename(dest));

  try {
    await writeFile(temp, content, { flag: "wx", mode: 0o600 });
    await link(temp, dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`Target already exists: ${target}`);

    throw new Error(`Could not publish target without replacement: ${(error as Error).message}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  const lines = content.length ? content.split("\n").length - (content.endsWith("\n") ? 1 : 0) : 0;

  return {
    path: relative(root, dest).split(sep).join("/"),
    bytes,
    lines,
    executor: result.executor,
    durationMs: result.durationMs,
    files: result.files,
    inputBytes: result.inputBytes,
  };
}
