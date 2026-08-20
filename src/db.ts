import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Event } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? join(__dirname, "..", "metrics.db");

// Node's built-in SQLite (>=22.5). No native dependency, no build scripts.
export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL,
    source      TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    user        TEXT NOT NULL,
    event       TEXT NOT NULL,
    tool        TEXT,
    project     TEXT,
    task_id     TEXT,
    model       TEXT,
    tokens_in   INTEGER NOT NULL DEFAULT 0,
    tokens_out  INTEGER NOT NULL DEFAULT 0,
    cache_read  INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    cost_usd    REAL,
    ext_id      TEXT,
    meta        TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(ts);
  CREATE INDEX IF NOT EXISTS idx_events_user    ON events(user);
  CREATE INDEX IF NOT EXISTS idx_events_event   ON events(event);
  CREATE INDEX IF NOT EXISTS idx_events_project ON events(project);
  CREATE INDEX IF NOT EXISTS idx_events_task    ON events(task_id);
  CREATE INDEX IF NOT EXISTS idx_events_model   ON events(model);
  -- Idempotency: (source, ext_id) unique when ext_id exists. A re-scan never duplicates.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_events_extid ON events(source, ext_id) WHERE ext_id IS NOT NULL;
`);

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO events
    (ts, source, session_id, user, event, tool, project, task_id, model,
     tokens_in, tokens_out, cache_read, cache_write, cost_usd, ext_id, meta)
  VALUES
    (:ts, :source, :session_id, :user, :event, :tool, :project, :task_id, :model,
     :tokens_in, :tokens_out, :cache_read, :cache_write, :cost_usd, :ext_id, :meta)
`);

/** Inserts events in a transaction; returns how many were written (ignores ext_id duplicates). */
export function insertEvents(events: Event[]): number {
  let inserted = 0;
  db.exec("BEGIN");
  try {
    for (const e of events) {
      const r = insertStmt.run({
        ts: e.ts ?? new Date().toISOString(),
        source: e.source,
        session_id: e.session_id,
        user: e.user,
        event: e.event,
        tool: e.tool ?? null,
        project: e.project ?? null,
        task_id: e.task_id ?? null,
        model: e.model ?? null,
        tokens_in: e.tokens_in ?? 0,
        tokens_out: e.tokens_out ?? 0,
        cache_read: e.cache_read ?? 0,
        cache_write: e.cache_write ?? 0,
        cost_usd: e.cost_usd ?? null,
        ext_id: e.ext_id ?? null,
        meta: JSON.stringify(e.meta ?? {}),
      });
      inserted += Number(r.changes);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return inserted;
}

/** Consolidated stats for a task/issue (used by /dash_stats). */
export function taskStats(taskId: string) {
  const summary = db
    .prepare(
      `SELECT
         COUNT(DISTINCT session_id) AS sessions,
         SUM(event='message')  AS messages,
         SUM(event='tool_use') AS tool_uses,
         SUM(event='error')    AS errors,
         SUM(tokens_in)   AS tokens_in,
         SUM(tokens_out)  AS tokens_out,
         SUM(cache_read)  AS cache_read,
         SUM(cache_write) AS cache_write,
         SUM(tokens_in+tokens_out+cache_read+cache_write) AS tokens_total,
         MIN(ts) AS first_seen, MAX(ts) AS last_seen,
         COUNT(DISTINCT date(ts)) AS days_active
       FROM events WHERE task_id = ?`
    )
    .get(taskId) as Record<string, number | string | null>;

  const by_model = db
    .prepare(
      `SELECT model, COUNT(*) AS messages,
              SUM(tokens_in+tokens_out+cache_read+cache_write) AS tokens
       FROM events WHERE task_id = ? AND event='message'
       GROUP BY model ORDER BY tokens DESC`
    )
    .all(taskId);

  const top_tools = db
    .prepare(
      `SELECT tool, COUNT(*) AS uses FROM events
       WHERE task_id = ? AND event='tool_use' AND tool IS NOT NULL
       GROUP BY tool ORDER BY uses DESC LIMIT 8`
    )
    .all(taskId);

  const lat = db
    .prepare(
      `SELECT json_extract(meta,'$.latency_ms') AS l FROM events
       WHERE task_id = ? AND event='message' AND json_extract(meta,'$.latency_ms') IS NOT NULL`
    )
    .all(taskId) as { l: number }[];
  const vals = lat.map((r) => r.l).sort((a, b) => a - b);
  const pct = (p: number) =>
    vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * (vals.length - 1)))] : null;
  const latency = {
    p50_ms: pct(0.5),
    p95_ms: pct(0.95),
    avg_ms: vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : null,
  };

  return { task_id: taskId, summary, by_model, top_tools, latency };
}
