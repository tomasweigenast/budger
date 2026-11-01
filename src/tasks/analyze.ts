import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { LoadedConfig } from "../core/config.js";
import { ProcessError } from "../executors/process.js";
import { type Attempt, executeRoutePrompt } from "./delegate.js";

const execFileAsync = promisify(execFile);

export type WorkspaceSnapshot = {
  directory: string;
  files: number;
  bytes: number;
  cleanup: () => Promise<void>;
};

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);

  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function gitOutput(cwd: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "buffer",
      maxBuffer: 256 * 1024 * 1024,
      ...(signal ? { signal } : {}),
    });

    return result.stdout;
  } catch (error) {
    if (signal?.aborted) throw new ProcessError("cancelled", "Execution cancelled");

    const detail = (error as Error & { stderr?: Buffer | string }).stderr?.toString().trim();

    throw new Error(`Could not list Git-visible project files${detail ? `: ${detail}` : ""}`);
  }
}

export async function createWorkspaceSnapshot(
  projectRoot: string,
  signal?: AbortSignal,
): Promise<WorkspaceSnapshot> {
  if (signal?.aborted) throw new ProcessError("cancelled", "Execution cancelled");

  const project = await realpath(projectRoot);
  let repository: string;

  try {
    repository = (await gitOutput(project, ["rev-parse", "--show-toplevel"], signal))
      .toString("utf8")
      .trim();
    repository = await realpath(repository);
  } catch (error) {
    if (error instanceof ProcessError) throw error;

    throw new Error(`Analysis requires a Git working tree: ${(error as Error).message}`);
  }

  if (!isInside(repository, project))
    throw new Error("Analysis project root is outside its Git working tree");

  const listed = await gitOutput(
    project,
    ["ls-files", "--cached", "--others", "--exclude-standard", "--full-name", "-z"],
    signal,
  );
  const directory = await mkdtemp(join(tmpdir(), "budger-analyze-"));
  let files = 0,
    bytes = 0;

  try {
    for (const rawPath of listed.toString("utf8").split("\0")) {
      if (!rawPath) continue;

      if (signal?.aborted) throw new ProcessError("cancelled", "Execution cancelled");

      const source = resolve(repository, ...rawPath.split("/"));

      if (!isInside(repository, source) || !isInside(project, source)) continue;

      let sourceReal: string;

      try {
        sourceReal = await realpath(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;

        throw error;
      }

      if (!isInside(project, sourceReal))
        throw new Error(`Refusing to snapshot a path outside the project: ${rawPath}`);

      const sourceStat = await stat(sourceReal);

      if (!sourceStat.isFile()) continue;

      const relativePath = relative(project, source);

      if (!relativePath || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))
        throw new Error(`Invalid Git path in workspace snapshot: ${rawPath}`);

      const target = resolve(directory, relativePath);

      if (!isInside(directory, target))
        throw new Error(`Invalid Git path in workspace snapshot: ${rawPath}`);

      await mkdir(dirname(target), { recursive: true });
      await copyFile(sourceReal, target);
      files++;
      bytes += sourceStat.size;
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    directory,
    files,
    bytes,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export async function analyzeWorkspace(
  loaded: LoadedConfig,
  question: string,
  signal?: AbortSignal,
  onAttempt?: (attempt: Attempt) => Promise<void> | void,
) {
  if (process.env.BUDGER_ACTIVE === "1")
    throw new ProcessError("cancelled", "Nested Budger delegation is disabled");

  if (!question.trim()) throw new Error("--question is required");

  const route = loaded.config.routes.analyze;

  if (!route) throw new Error("Unknown route: analyze (configure routes.analyze first)");

  const prompt = `${route.instructions}\n\nQuestion:\n${question}`;
  const inputBytes = Buffer.byteLength(prompt);

  if (inputBytes > route.limits.maxInputBytes)
    throw new Error("Constructed prompt exceeds route input limit");

  const snapshot = await createWorkspaceSnapshot(loaded.projectRoot, signal);

  try {
    const result = await executeRoutePrompt(
      loaded,
      "analyze",
      prompt,
      snapshot.directory,
      0,
      inputBytes,
      signal,
      onAttempt,
      true,
    );

    return {
      executor: result.executor,
      text: result.text,
      attempts: result.attempts,
      durationMs: result.durationMs,
      ...(result.usage ? { usage: result.usage } : {}),
      workspaceFiles: snapshot.files,
      workspaceBytes: snapshot.bytes,
    };
  } finally {
    await snapshot.cleanup();
  }
}
