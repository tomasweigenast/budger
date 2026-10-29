import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { LoadedConfig } from "../core/config.js";
import type { Attempt } from "../tasks/delegate.js";

function dbPath(): string {
  const root =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
      : process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");

  return join(root, "budger", "metrics.sqlite");
}

async function createDb(): Promise<void> {
  await mkdir(dirname(dbPath()), { recursive: true, mode: 0o700 });
}

function createTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, started_at TEXT NOT NULL, project_hash TEXT NOT NULL, route TEXT NOT NULL,
      duration_ms INTEGER, status TEXT NOT NULL, executor TEXT, files INTEGER, input_bytes INTEGER,
      result_bytes INTEGER, estimated_input_tokens INTEGER, estimated_output_tokens INTEGER,
      potential_avoided_tokens INTEGER, estimate_method TEXT
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, attempt_no INTEGER NOT NULL,
      executor TEXT NOT NULL, duration_ms INTEGER NOT NULL, status TEXT NOT NULL, exit_code INTEGER,
      error_kind TEXT, signal TEXT, input_tokens INTEGER, output_tokens INTEGER, cached_input_tokens INTEGER, reasoning_output_tokens INTEGER,
      UNIQUE(run_id, attempt_no)
    );
    CREATE TABLE IF NOT EXISTS costs (
      id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
      amount REAL NOT NULL, currency TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('reported','estimated')), rate_reference TEXT
    );`);
}

async function open(): Promise<DatabaseSync> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath());

  try {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
    );
    const hasRuns = !!db
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='runs'")
      .get();

    if (hasRuns) {
      const columns = db.prepare("PRAGMA table_info(runs)").all() as {
        name: string;
        notnull: number;
      }[];
      const names = new Set(columns.map((column) => column.name));
      const oldRequiredExecutor = columns.some(
        (column) => column.name === "executor" && column.notnull === 1,
      );

      if (oldRequiredExecutor) {
        const hasAttempts = !!db
          .prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='attempts'")
          .get();

        if (hasAttempts)
          throw new Error(
            "Legacy metrics schema with attempts cannot be migrated automatically; back up the database before changing its schema",
          );

        db.exec("BEGIN IMMEDIATE");

        try {
          db.exec("ALTER TABLE runs RENAME TO runs_legacy_v1");
          createTables(db);
          db.exec(`INSERT INTO runs(id, started_at, project_hash, route, duration_ms, status, executor, files, input_bytes, result_bytes, estimated_input_tokens, estimated_output_tokens)
            SELECT id, started_at, project_hash, route, duration_ms, status, executor, files, input_bytes, result_bytes, estimated_input_tokens, estimated_output_tokens FROM runs_legacy_v1`);
          db.exec("DROP TABLE runs_legacy_v1; COMMIT");
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* transaction already ended */
          }

          throw error;
        }
      } else {
        if (!names.has("potential_avoided_tokens"))
          db.exec("ALTER TABLE runs ADD COLUMN potential_avoided_tokens INTEGER");

        if (!names.has("estimate_method"))
          db.exec("ALTER TABLE runs ADD COLUMN estimate_method TEXT");

        createTables(db);
      }
    } else createTables(db);

    const attemptColumns = db.prepare("PRAGMA table_info(attempts)").all() as { name: string }[];

    if (attemptColumns.length && !attemptColumns.some((column) => column.name === "signal"))
      db.exec("ALTER TABLE attempts ADD COLUMN signal TEXT");

    db.exec(
      "CREATE INDEX IF NOT EXISTS runs_started_at_idx ON runs(started_at); CREATE INDEX IF NOT EXISTS attempts_run_id_idx ON attempts(run_id);",
    );
    db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, ?)").run(
      new Date().toISOString(),
    );

    return db;
  } catch (error) {
    db.close();

    throw error;
  }
}

export async function beginRun(
  loaded: LoadedConfig,
  route: string,
  runId = randomUUID(),
): Promise<string> {
  if (!loaded.config.metrics.enabled) return runId;

  await createDb();
  const db = await open();

  try {
    db.prepare(
      "INSERT INTO runs(id, started_at, project_hash, route, status) VALUES (?, ?, ?, ?, 'running')",
    ).run(
      runId,
      new Date().toISOString(),
      createHash("sha256").update(loaded.projectRoot).digest("hex"),
      route,
    );
  } finally {
    db.close();
  }

  return runId;
}

export async function recordAttempt(
  loaded: LoadedConfig,
  runId: string,
  attemptNo: number,
  attempt: Attempt,
): Promise<void> {
  if (!loaded.config.metrics.enabled) return;

  await createDb();
  const db = await open(),
    id = randomUUID();

  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare(`INSERT INTO attempts(id, run_id, attempt_no, executor, duration_ms, status, exit_code, error_kind, signal, input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      runId,
      attemptNo,
      attempt.executor,
      attempt.durationMs,
      attempt.status,
      attempt.exitCode ?? null,
      attempt.errorKind ?? null,
      attempt.signal ?? null,
      attempt.inputTokens ?? null,
      attempt.outputTokens ?? null,
      attempt.cachedInputTokens ?? null,
      attempt.reasoningOutputTokens ?? null,
    );

    if (attempt.reportedCost !== undefined && attempt.currency)
      db.prepare(
        "INSERT INTO costs(id, attempt_id, amount, currency, source, rate_reference) VALUES (?, ?, ?, ?, 'reported', NULL)",
      ).run(randomUUID(), id, attempt.reportedCost, attempt.currency);

    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* transaction already ended */
    }

    throw error;
  } finally {
    db.close();
  }
}

export async function finishRun(
  loaded: LoadedConfig,
  runId: string,
  result: {
    status: "success" | "error";
    durationMs: number;
    executor?: string;
    files?: number;
    inputBytes?: number;
    resultBytes?: number;
    estimateTokens: boolean;
    estimateAvoided?: boolean;
  },
): Promise<void> {
  if (!loaded.config.metrics.enabled) return;

  await createDb();
  const db = await open();
  const input =
    result.estimateTokens && result.inputBytes !== undefined
      ? Math.ceil(result.inputBytes / 4)
      : null;
  const output =
    result.estimateTokens && result.resultBytes !== undefined
      ? Math.ceil(result.resultBytes / 4)
      : null;
  const avoided =
    result.estimateAvoided !== false && input !== null && output !== null ? input - output : null;

  try {
    db.prepare(
      `UPDATE runs SET duration_ms=?, status=?, executor=?, files=?, input_bytes=?, result_bytes=?, estimated_input_tokens=?, estimated_output_tokens=?, potential_avoided_tokens=?, estimate_method=? WHERE id=?`,
    ).run(
      result.durationMs,
      result.status,
      result.executor ?? null,
      result.files ?? null,
      result.inputBytes ?? null,
      result.resultBytes ?? null,
      input,
      output,
      avoided,
      input === null ? null : "ceil_utf8_bytes_div_4_v1",
      runId,
    );
  } finally {
    db.close();
  }
}

export async function readStats(lastDays = 30): Promise<{
  runs: number;
  successes: number;
  failures: number;
  avgDurationMs: number | null;
  estimatedInputTokens: number | null;
  estimatedOutputTokens: number | null;
  potentialAvoidedTokens: number | null;
  reportedInputTokens: number | null;
  reportedOutputTokens: number | null;
  reportedCachedInputTokens: number | null;
  reportedReasoningOutputTokens: number | null;
  runsWithReportedUsage: number;
  attempts: number;
  failedAttempts: number;
  fallbacks: number;
  costs: { currency: string; source: string; amount: number }[];
}> {
  await createDb();
  const db = await open();

  try {
    const since = new Date(Date.now() - lastDays * 86_400_000).toISOString();
    const stats = db
      .prepare(`SELECT COUNT(*) AS runs, SUM(status='success') AS successes, SUM(status='error') AS failures, AVG(duration_ms) AS avgDurationMs,
      SUM(estimated_input_tokens) AS estimatedInputTokens, SUM(estimated_output_tokens) AS estimatedOutputTokens, SUM(potential_avoided_tokens) AS potentialAvoidedTokens
      FROM runs WHERE started_at >= ? AND status != 'running'`)
      .get(since) as Record<string, number | null>;
    const usage = db
      .prepare(`SELECT SUM(a.input_tokens) AS reportedInputTokens, SUM(a.output_tokens) AS reportedOutputTokens,
      SUM(a.cached_input_tokens) AS reportedCachedInputTokens, SUM(a.reasoning_output_tokens) AS reportedReasoningOutputTokens,
      COUNT(DISTINCT CASE WHEN a.input_tokens IS NOT NULL OR a.output_tokens IS NOT NULL THEN a.run_id END) AS runsWithReportedUsage,
      COUNT(*) AS attempts, SUM(a.status='error') AS failedAttempts, SUM(a.attempt_no > 1) AS fallbacks
      FROM attempts a JOIN runs r ON r.id=a.run_id WHERE r.started_at >= ? AND r.status != 'running'`)
      .get(since) as Record<string, number | null>;
    const costs = db
      .prepare(
        `SELECT c.currency, c.source, SUM(c.amount) AS amount FROM costs c JOIN attempts a ON a.id=c.attempt_id JOIN runs r ON r.id=a.run_id WHERE r.started_at >= ? AND r.status != 'running' GROUP BY c.currency, c.source ORDER BY c.currency, c.source`,
      )
      .all(since) as { currency: string; source: string; amount: number }[];

    return {
      runs: stats.runs ?? 0,
      successes: stats.successes ?? 0,
      failures: stats.failures ?? 0,
      avgDurationMs: stats.avgDurationMs ?? null,
      estimatedInputTokens: stats.estimatedInputTokens ?? null,
      estimatedOutputTokens: stats.estimatedOutputTokens ?? null,
      potentialAvoidedTokens: stats.potentialAvoidedTokens ?? null,
      reportedInputTokens: usage.reportedInputTokens ?? null,
      reportedOutputTokens: usage.reportedOutputTokens ?? null,
      reportedCachedInputTokens: usage.reportedCachedInputTokens ?? null,
      reportedReasoningOutputTokens: usage.reportedReasoningOutputTokens ?? null,
      runsWithReportedUsage: usage.runsWithReportedUsage ?? 0,
      attempts: usage.attempts ?? 0,
      failedAttempts: usage.failedAttempts ?? 0,
      fallbacks: usage.fallbacks ?? 0,
      costs,
    };
  } finally {
    db.close();
  }
}
