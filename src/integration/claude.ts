import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const skillNames = ["budger-bulk-reader", "budger-code-writer"];

type ClaudeScope = "project" | "user";

function claudeRoot(projectRoot: string, scope: ClaudeScope): string {
  return scope === "user" ? homedir() : projectRoot;
}

function artifactPaths(root: string): string[] {
  return [
    ...skillNames.map((name) => join(root, ".claude", "skills", name, "SKILL.md")),
    join(root, ".claude", "budger", "cli.mjs"),
  ];
}

function hook(matcher: string, runtime: string) {
  return {
    matcher,
    hooks: [
      {
        type: "command",
        command: "node",
        args: [runtime, "hook", "pre-tool-use"],
        timeout: 5,
        onFailure: "continue",
      },
    ],
  };
}

function ownedHooks(root: string, scope: ClaudeScope) {
  const runtime =
    scope === "user"
      ? join(root, ".claude", "budger", "cli.mjs")
      : // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands this placeholder.
        "${CLAUDE_PROJECT_DIR}/.claude/budger/cli.mjs";

  return [hook("Read", runtime), hook("Bash", runtime)];
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isOwnedHook(value: unknown, hooks: ReturnType<typeof ownedHooks>): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const entry = value as Record<string, unknown>;

  return hooks.some((item) => item.matcher === entry.matcher && same(item.hooks, entry.hooks));
}

function mergeHooks(settings: Record<string, unknown>, hooks: ReturnType<typeof ownedHooks>) {
  const current = settings.hooks;

  if (current !== undefined && (!current || typeof current !== "object" || Array.isArray(current)))
    throw new Error("settings hooks must be an object keyed by event name");

  const events = { ...((current ?? {}) as Record<string, unknown>) };
  const preToolUse = events.PreToolUse ?? [];

  if (!Array.isArray(preToolUse)) throw new Error("settings hooks.PreToolUse must be an array");

  events.PreToolUse = [...preToolUse.filter((entry) => !isOwnedHook(entry, hooks)), ...hooks];

  return events;
}

async function hash(path: string): Promise<string | null> {
  try {
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  } catch {
    return null;
  }
}

async function atomicWrite(path: string, contents: string, mode = 0o600): Promise<void> {
  const temp = join(dirname(path), `.budger-${randomUUID()}.tmp`);

  try {
    await writeFile(temp, contents, { flag: "wx", mode });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

async function existingMode(path: string): Promise<number> {
  try {
    return (await lstat(path)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0o600;

    throw error;
  }
}

async function optionalFile(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;

    throw error;
  }
}

async function assertNoFinalSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error(`Refusing to follow symlink: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertProjectPath(projectRoot: string, target: string): Promise<void> {
  const root = await realpath(projectRoot);
  let parent = dirname(target);

  while (true) {
    try {
      const resolved = await realpath(parent),
        rel = relative(root, resolved);

      if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep))
        throw new Error(`Claude integration path escapes project root: ${target}`);

      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

      const next = dirname(parent);

      if (next === parent) throw error;

      parent = next;
    }
  }
}

export async function installClaude(
  projectRoot: string,
  scope: ClaudeScope = "project",
): Promise<void> {
  const root = claudeRoot(projectRoot, scope);
  const settingsPath = join(
    root,
    ".claude",
    scope === "user" ? "settings.json" : "settings.local.json",
  );
  const runtimePath = join(root, ".claude", "budger", "cli.mjs");
  const manifestPath = join(root, ".claude", "budger", "manifest.json");
  const hooks = ownedHooks(root, scope);
  const artifacts = [
    ...skillNames.map((name) => ({
      source: join(packageRoot, "assets", "skills", name, "SKILL.md"),
      target: join(root, ".claude", "skills", name, "SKILL.md"),
    })),
    { source: join(packageRoot, "dist", "cli", "main.js"), target: runtimePath },
  ];
  const allowedArtifacts = new Set(artifacts.map((artifact) => artifact.target));
  await Promise.all(
    [settingsPath, manifestPath, ...artifacts.map((artifact) => artifact.target)].map((target) =>
      assertProjectPath(root, target),
    ),
  );
  await Promise.all(
    [settingsPath, manifestPath, ...artifacts.map((artifact) => artifact.target)].map(
      assertNoFinalSymlink,
    ),
  );
  const settingsBytes = await optionalFile(settingsPath);
  const settingsMode = await existingMode(settingsPath);
  let settings: Record<string, unknown> = {};

  if (settingsBytes) {
    try {
      const parsed = JSON.parse(settingsBytes.toString("utf8"));

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("settings root must be an object");

      if (
        parsed.hooks !== undefined &&
        (!parsed.hooks || typeof parsed.hooks !== "object" || Array.isArray(parsed.hooks))
      )
        throw new Error("settings hooks must be an object keyed by event name");

      if (parsed.hooks?.PreToolUse !== undefined && !Array.isArray(parsed.hooks.PreToolUse))
        throw new Error("settings hooks.PreToolUse must be an array");

      settings = parsed;
    } catch (error) {
      throw new Error(`Invalid Claude settings file: ${(error as Error).message}`);
    }
  }

  let previousHashes: Record<string, string> = {};
  const manifestBytes = await optionalFile(manifestPath);

  if (manifestBytes) {
    try {
      const manifest = JSON.parse(manifestBytes.toString("utf8"));

      if (
        !manifest ||
        typeof manifest !== "object" ||
        manifest.version !== 1 ||
        !manifest.hashes ||
        typeof manifest.hashes !== "object" ||
        Array.isArray(manifest.hashes)
      )
        throw new Error("invalid manifest format");

      previousHashes = manifest.hashes;

      for (const [path, expected] of Object.entries(previousHashes))
        if (
          !allowedArtifacts.has(path) ||
          typeof expected !== "string" ||
          !/^[0-9a-f]{64}$/.test(expected)
        )
          throw new Error("invalid manifest entry");
    } catch {
      throw new Error("Invalid Budger installation manifest");
    }
  }

  for (const artifact of artifacts) {
    await readFile(artifact.source);
    const currentHash = await hash(artifact.target);

    if (currentHash && previousHashes[artifact.target] !== currentHash)
      throw new Error(`Refusing to replace a modified or unowned file: ${artifact.target}`);
  }

  const mergedSettings = {
    ...settings,
    hooks: mergeHooks(settings, hooks),
  };
  const settingsContent = `${JSON.stringify(mergedSettings, null, 2)}\n`;

  const hashes: Record<string, string> = {};

  for (const artifact of artifacts) {
    await mkdir(dirname(artifact.target), { recursive: true });
    const temp = join(dirname(artifact.target), `.budger-${randomUUID()}.tmp`);

    try {
      let contents = await readFile(artifact.source);

      if (scope === "user")
        contents = Buffer.from(
          contents
            .toString("utf8")
            .replaceAll("node .claude/budger/cli.mjs", `node "${runtimePath}"`),
        );

      await writeFile(temp, contents, { flag: "wx", mode: 0o600 });
      await rename(temp, artifact.target);
    } finally {
      await rm(temp, { force: true });
    }

    const artifactHash = await hash(artifact.target);

    if (artifactHash === null)
      throw new Error(`Could not hash installed artifact: ${artifact.target}`);

    hashes[artifact.target] = artifactHash;
  }

  await atomicWrite(manifestPath, `${JSON.stringify({ version: 1, hashes }, null, 2)}\n`);

  const latestSettings = await optionalFile(settingsPath);

  if (latestSettings?.toString("base64") !== settingsBytes?.toString("base64"))
    throw new Error(
      "Claude settings changed during Budger installation; review and run init again",
    );

  await atomicWrite(settingsPath, settingsContent, settingsMode);
}

export async function uninstallClaude(
  projectRoot: string,
  scope: ClaudeScope = "project",
): Promise<void> {
  const root = claudeRoot(projectRoot, scope);
  const manifestPath = join(root, ".claude", "budger", "manifest.json");
  const settingsPath = join(
    root,
    ".claude",
    scope === "user" ? "settings.json" : "settings.local.json",
  );
  const hooks = ownedHooks(root, scope);
  await assertProjectPath(root, manifestPath);
  await assertNoFinalSymlink(manifestPath);
  let manifest: { version: number; hashes: Record<string, string> };
  let manifestBytes: Buffer;

  try {
    manifestBytes = await readFile(manifestPath);
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;

    throw new Error(`Could not read Budger installation manifest: ${(error as Error).message}`);
  }

  const allowed = new Set(artifactPaths(root));

  if (
    !manifest ||
    typeof manifest !== "object" ||
    manifest.version !== 1 ||
    !manifest.hashes ||
    typeof manifest.hashes !== "object" ||
    Array.isArray(manifest.hashes)
  )
    throw new Error("Invalid Budger installation manifest");

  for (const [path, expected] of Object.entries(manifest.hashes))
    if (!allowed.has(path) || typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected))
      throw new Error("Invalid Budger installation manifest entry");

  await Promise.all(
    [settingsPath, ...artifactPaths(root)].map((target) => assertProjectPath(root, target)),
  );
  await Promise.all([settingsPath, ...artifactPaths(root)].map(assertNoFinalSymlink));
  const settingsBytes = await optionalFile(settingsPath);
  const settingsMode = await existingMode(settingsPath);

  if (settingsBytes) {
    let settings: Record<string, unknown>;

    try {
      const parsed = JSON.parse(settingsBytes.toString("utf8"));

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("settings root must be an object");

      if (
        parsed.hooks !== undefined &&
        (!parsed.hooks || typeof parsed.hooks !== "object" || Array.isArray(parsed.hooks))
      )
        throw new Error("settings hooks must be an object keyed by event name");

      if (parsed.hooks?.PreToolUse !== undefined && !Array.isArray(parsed.hooks.PreToolUse))
        throw new Error("settings hooks.PreToolUse must be an array");

      settings = parsed;
    } catch (error) {
      throw new Error(`Invalid Claude settings file: ${(error as Error).message}`);
    }

    if (settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)) {
      const events = { ...(settings.hooks as Record<string, unknown>) };
      const preToolUse = events.PreToolUse;

      if (Array.isArray(preToolUse)) {
        const remaining = preToolUse.filter((entry) => !isOwnedHook(entry, hooks));

        if (remaining.length) events.PreToolUse = remaining;
        else delete events.PreToolUse;
      }

      if (Object.keys(events).length) settings.hooks = events;
      else delete settings.hooks;
    }

    const latest = await optionalFile(settingsPath);

    if (latest?.toString("base64") !== settingsBytes.toString("base64"))
      throw new Error(
        "Claude settings changed during Budger uninstall; retry after reviewing them",
      );

    await atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, settingsMode);
  }

  const latestManifest = await optionalFile(manifestPath);

  if (latestManifest?.toString("base64") !== manifestBytes.toString("base64"))
    throw new Error("Budger manifest changed during uninstall; retry after reviewing it");

  for (const [path, expected] of Object.entries(manifest.hashes))
    if ((await hash(path)) === expected) await rm(path, { force: true });

  await rm(manifestPath, { force: true });
}
