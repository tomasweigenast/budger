import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { LoadedConfig } from "../core/config.js";

export type HookDecision = { action: "pass" } | { action: "deny"; reason: string };

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);

  return rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
}

async function bigFile(
  path: string,
  cwd: string,
  projectRoot: string,
  threshold: number,
): Promise<boolean> {
  try {
    const realRoot = await realpath(projectRoot),
      real = await realpath(resolve(cwd, path));

    if (!inside(realRoot, real)) return false;

    let lines = 0,
      bytes = 0,
      last = -1;

    for await (const chunk of createReadStream(real)) {
      const buffer = chunk as Buffer;
      bytes += buffer.length;

      for (const byte of buffer) {
        last = byte;

        if (byte === 10 && ++lines > threshold) return true;
      }
    }

    return bytes > 0 && last !== 10 && lines + 1 > threshold;
  } catch {
    return false;
  }
}

function tokenize(command: string): string[] | null {
  if (/[|&;<>()$`*?[\]{}\n\r]/.test(command)) return null;

  const tokens: string[] = [];
  let token = "",
    quote = "",
    started = false;

  for (let i = 0; i < command.length; i++) {
    const c = command.charAt(i);

    if (quote) {
      if (c === quote) quote = "";
      else token += c;

      started = true;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === "\\") {
      if (++i >= command.length) return null;

      token += command.charAt(i);
      started = true;
    } else if (/\s/.test(c)) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
    } else {
      token += c;
      started = true;
    }
  }

  if (quote) return null;

  if (started) tokens.push(token);

  return tokens;
}

function bashFiles(
  tokens: string[],
  threshold: number,
): { files: string[]; bounded: boolean } | null {
  const command = tokens.shift();

  if (!command || !["cat", "head", "tail", "less", "more"].includes(command)) return null;

  let maxLines = Infinity,
    follow = false,
    opts = true;
  const files: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const arg = tokens[i];

    if (arg === undefined) return null;

    if (opts && arg === "--") {
      opts = false;
      continue;
    }

    if (opts && (arg === "-f" || arg === "--follow")) {
      follow = true;
      continue;
    }

    if (
      opts &&
      command === "cat" &&
      [
        "-n",
        "--number",
        "-b",
        "--number-nonblank",
        "-s",
        "--squeeze-blank",
        "-v",
        "-T",
        "-E",
        "-A",
        "-e",
        "-t",
        "-u",
      ].includes(arg)
    )
      continue;

    if (opts && command === "head" && (/^-\d+$/.test(arg) || arg === "-n" || arg === "--lines")) {
      const val = /^-\d+$/.test(arg) ? Number(arg.slice(1)) : Number(tokens[++i]);

      if (!Number.isInteger(val)) return null;

      maxLines = val < 0 ? Infinity : val;
      continue;
    }

    if (
      opts &&
      command === "head" &&
      (/^--lines=[+-]?\d+$/.test(arg) || /^-n=?[+-]?\d+$/.test(arg))
    ) {
      const val = Number(arg.slice(arg.indexOf("=") >= 0 ? arg.indexOf("=") + 1 : 2));
      maxLines = val < 0 ? Infinity : val;
      continue;
    }

    if (opts && command === "tail" && (arg === "-n" || arg === "--lines" || /^-\d+$/.test(arg))) {
      const val = /^-\d+$/.test(arg) ? arg.slice(1) : tokens[++i];

      if (!val || !/^[+-]?\d+$/.test(val)) return null;

      maxLines = val.startsWith("+") ? Infinity : Number(val);
      continue;
    }

    if (
      opts &&
      command === "tail" &&
      (/^--lines=[+-]?\d+$/.test(arg) || /^-n=?[+-]?\d+$/.test(arg))
    ) {
      const val = arg.slice(arg.indexOf("=") >= 0 ? arg.indexOf("=") + 1 : 2);
      maxLines = val.startsWith("+") ? Infinity : Math.abs(Number(val));
      continue;
    }

    if (opts && arg.startsWith("-")) return null;

    files.push(arg);
  }

  if (!files.length || follow) return null;

  if (command === "head" || command === "tail") return { files, bounded: maxLines <= threshold };

  return { files, bounded: false };
}

export async function evaluateHook(payload: unknown, loaded: LoadedConfig): Promise<HookDecision> {
  if (process.env.BUDGER_ACTIVE === "1" || process.env.BUDGER_DISABLE_HOOKS === "1")
    return { action: "pass" };

  if (!payload || typeof payload !== "object") return { action: "pass" };

  const data = payload as Record<string, unknown>,
    name = data.tool_name,
    input = data.tool_input;

  if (!input || typeof input !== "object") return { action: "pass" };

  const tool = input as Record<string, unknown>;

  if (name === "Read") {
    const policy = loaded.config.hooks.read;

    if (!policy.enabled || typeof tool.file_path !== "string") return { action: "pass" };

    if (
      policy.allowBoundedReads &&
      typeof tool.limit === "number" &&
      Number.isInteger(tool.limit) &&
      tool.limit > 0 &&
      tool.limit <= policy.minLines
    )
      return { action: "pass" };

    if (
      await bigFile(
        tool.file_path,
        typeof data.cwd === "string" ? data.cwd : loaded.projectRoot,
        loaded.projectRoot,
        policy.minLines,
      )
    )
      return {
        action: "deny",
        reason: `Archivo grande. Usá /budger-bulk-reader o una lectura acotada con limit.`,
      };

    return { action: "pass" };
  }

  if (name === "Bash") {
    const policy = loaded.config.hooks.bash;

    if (!policy.enabled || typeof tool.command !== "string") return { action: "pass" };

    const tokens = tokenize(tool.command);

    if (!tokens) return { action: "pass" };

    const parsed = bashFiles(tokens, policy.minLines);

    if (!parsed) return { action: "pass" };

    if (policy.allowBoundedReads && parsed.bounded) return { action: "pass" };

    const cwd = typeof data.cwd === "string" ? data.cwd : loaded.projectRoot;

    for (const path of parsed.files)
      if (await bigFile(path, cwd, loaded.projectRoot, policy.minLines))
        return {
          action: "deny",
          reason: `Archivo grande. Usá /budger-bulk-reader o una lectura acotada con limit.`,
        };
  }

  return { action: "pass" };
}
