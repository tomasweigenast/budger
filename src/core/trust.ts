import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { BudgerConfig, LoadedConfig } from "./config.js";

function stateFile(projectRoot: string): string {
  const root =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
      : process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  const projectId = createHash("sha256").update(projectRoot).digest("hex");

  return join(root, "budger", "trust", `${projectId}.json`);
}

export function configFingerprint(config: BudgerConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export async function isTrusted(loaded: LoadedConfig): Promise<boolean> {
  const path = stateFile(loaded.projectRoot);

  try {
    const trusted = JSON.parse(await readFile(path, "utf8")) as { fingerprint: string };

    return trusted.fingerprint === configFingerprint(loaded.config);
  } catch {
    return false;
  }
}

export async function authorize(loaded: LoadedConfig): Promise<void> {
  const path = stateFile(loaded.projectRoot);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.budger-${randomUUID()}.tmp`);

  try {
    await writeFile(
      temp,
      `${JSON.stringify({ fingerprint: configFingerprint(loaded.config) })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
