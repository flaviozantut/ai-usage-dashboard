#!/usr/bin/env node
/**
 * Cursor hook (`stop` event) — automatic, no manual collector.
 *
 * The Cursor payload doesn't carry tokens. So:
 *   1) ALWAYS record the turn's activity right away (event="stop").
 *   2) IF CURSOR_API_KEY is set, fire (throttled) an Admin API pull that fills in:
 *        - EXACT tokens (filtered-usage-events)  → "message" events
 *        - daily productivity (daily-usage-data)  → "productivity" events (accept rate)
 *
 * Fail-safe: never breaks Cursor (exit 0). Idempotent by ext_id.
 *
 * Register it in ~/.cursor/hooks.json (see hooks/cursor-hooks.example.json).
 * Writes straight to the local SQLite DB — no server to keep running.
 * Env: IA_USAGE_DASHBOARD_DB_PATH (SQLite file), CURSOR_API_KEY (optional),
 *      CURSOR_LOOKBACK_MIN (default 30), CURSOR_THROTTLE_S (default 120),
 *      DASH_STATE (default ~/.cursor/dash-state)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fetchTokenEvents, fetchDailyProductivity } from "../lib/cursor-api.mjs";
import { extractTaskId } from "../lib/task.mjs";
import { insertEvents } from "../lib/db.mjs";

const CURSOR_KEY = process.env.CURSOR_API_KEY;
const LOOKBACK = Number(process.env.CURSOR_LOOKBACK_MIN ?? 30) * 60_000;
const THROTTLE = Number(process.env.CURSOR_THROTTLE_S ?? 120) * 1000;
const STATE_DIR = process.env.DASH_STATE ?? join(homedir(), ".cursor", "dash-state");

function saveEvents(events) {
  if (!events.length) return;
  insertEvents(events);
}

async function pull(h) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tsFile = join(STATE_DIR, "last-pull");
  let last = 0;
  try {
    last = parseInt(readFileSync(tsFile, "utf8"), 10) || 0;
  } catch {}
  if (Date.now() - last < THROTTLE) return;

  const endDate = Date.now();
  const startDate = endDate - LOOKBACK;
  const tokens = await fetchTokenEvents(CURSOR_KEY, startDate, endDate, h.user_email ?? null);
  saveEvents(tokens);
  const prod = await fetchDailyProductivity(CURSOR_KEY, startDate, endDate);
  saveEvents(prod);
  writeFileSync(tsFile, String(Date.now()));
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let h = {};
  try {
    h = JSON.parse(raw);
  } catch {}

  // task_id from the workspace's git branch
  const root = Array.isArray(h.workspace_roots) ? h.workspace_roots[0] : null;
  let task_id;
  if (root) {
    try {
      const branch = execFileSync("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf8",
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      task_id = extractTaskId(branch) ?? undefined;
    } catch {}
  }

  // 1) turn activity (event="stop", doesn't pollute the token sum)
  try {
    saveEvents([
      {
        source: "cursor",
        session_id: h.conversation_id ?? "unknown",
        user: "self",
        event: "stop",
        model: h.model,
        ext_id: "cursor-turn:" + (h.generation_id ?? `${h.conversation_id}:${Date.now()}`),
        project: root ? root.split("/").pop() : undefined,
        task_id,
        meta: { status: h.status, generationId: h.generation_id },
      },
    ]);
  } catch {}

  // 2) exact tokens + productivity via Admin API
  if (CURSOR_KEY) {
    try {
      await pull(h);
    } catch {}
  }
}

main().finally(() => process.exit(0));
