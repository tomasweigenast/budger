import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const skillNames = ["budger-bulk-reader", "budger-code-writer"];

function artifactPaths(projectRoot: string): string[] {
  return [
    ...skillNames.map((name) => join(projectRoot, ".claude", "skills", name, "SKILL.md")),
    join(projectRoot, ".claude", "budger", "cli.mjs"),
  ];
}

function hook(matcher: string) {
  return {
    matcher,
    hooks: [
      {
        type: "command",
        command: "node",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands this placeholder.
        args: ["${CLAUDE_PROJECT_DIR}/.claude/budger/cli.mjs", "hook", "pre-tool-use"],
        timeout: 5,
        onFailure: "continue",
      },
    ],
  };
}

const ownedHooks = [hook("Read"), hook("Bash")];

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isOwnedHook(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const entry = value as Record<string, unknown>;

  return ownedHooks.some((item) => item.matcher === entry.matcher && same(item.hooks, entry.hooks));
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

export async function installClaude(projectRoot: string): Promise<void> {
  const settingsPath = join(projectRoot, ".claude", "settings.local.json");
  const runtimePath = join(projectRoot, ".claude", "budger", "cli.mjs");
  const manifestPath = join(projectRoot, ".claude", "budger", "manifest.json");
  const artifacts = [
    ...skillNames.map((name) => ({
      source: join(packageRoot, "assets", "skills", name, "SKILL.md"),
      target: join(projectRoot, ".claude", "skills", name, "SKILL.md"),
    })),
    { source: join(packageRoot, "dist", "cli", "main.js"), target: runtimePath },
  ];
  const allowedArtifacts = new Set(artifacts.map((artifact) => artifact.target));
  await Promise.all(
    [settingsPath, manifestPath, ...artifacts.map((artifact) => artifact.target)].map((target) =>
      assertProjectPath(projectRoot, target),
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

      if (parsed.hooks !== undefined && !Array.isArray(parsed.hooks))
        throw new Error("settings hooks must be an array");

      settings = parsed;
    } catch (error) {
      throw new Error(`Invalid Claude settings file: ${(error as Error).message}`);
    }
  }

  const existingHooks = Array.isArray(settings.hooks) ? (settings.hooks as unknown[]) : [];
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
    hooks: [...existingHooks.filter((entry) => !isOwnedHook(entry)), ...ownedHooks],
  };
  const settingsContent = `${JSON.stringify(mergedSettings, null, 2)}\n`;

  const hashes: Record<string, string> = {};

  for (const artifact of artifacts) {
    await mkdir(dirname(artifact.target), { recursive: true });
    const temp = join(dirname(artifact.target), `.budger-${randomUUID()}.tmp`);

    try {
      await copyFile(artifact.source, temp);
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

export async function uninstallClaude(projectRoot: string): Promise<void> {
  const manifestPath = join(projectRoot, ".claude", "budger", "manifest.json");
  const settingsPath = join(projectRoot, ".claude", "settings.local.json");
  await assertProjectPath(projectRoot, manifestPath);
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

  const allowed = new Set(artifactPaths(projectRoot));

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
    [settingsPath, ...artifactPaths(projectRoot)].map((target) =>
      assertProjectPath(projectRoot, target),
    ),
  );
  await Promise.all([settingsPath, ...artifactPaths(projectRoot)].map(assertNoFinalSymlink));
  const settingsBytes = await optionalFile(settingsPath);
  const settingsMode = await existingMode(settingsPath);

  if (settingsBytes) {
    let settings: Record<string, unknown>;

    try {
      const parsed = JSON.parse(settingsBytes.toString("utf8"));

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("settings root must be an object");

      if (parsed.hooks !== undefined && !Array.isArray(parsed.hooks))
        throw new Error("settings hooks must be an array");

      settings = parsed;
    } catch (error) {
      throw new Error(`Invalid Claude settings file: ${(error as Error).message}`);
    }

    if (Array.isArray(settings.hooks))
      settings.hooks = (settings.hooks as unknown[]).filter((entry) => !isOwnedHook(entry));

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
