#!/usr/bin/env node
/**
 * Stats for a task — used by the /dash_stats slash command.
 *
 *   node task-stats.mjs DEMO-100   → stats for the given task
 *   node task-stats.mjs            → stats for the ACTIVE task of the current session
 *                                    (most recent task state file)
 *
 * Reads the local SQLite DB directly — no server needed.
 * Env: IA_USAGE_DASHBOARD_DB_PATH (SQLite file), DASH_STATE.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { taskStats } from "../lib/db.mjs";

const STATE_DIR = process.env.DASH_STATE ?? join(homedir(), ".claude", "dash-state");

function activeTask() {
  const dir = join(STATE_DIR, "tasks");
  let newest = null;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const p = join(dir, f);
      const mt = statSync(p).mtimeMs;
      if (!newest || mt > newest.mt) newest = { mt, path: p };
    }
  } catch {}
  if (!newest) return null;
  try {
    return JSON.parse(readFileSync(newest.path, "utf8")).task_id ?? null;
  } catch {
    return null;
  }
}

const fmt = (n) => (n ?? 0).toLocaleString("en-US");
const compact = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + " B" : n >= 1e6 ? (n / 1e6).toFixed(1) + " M" : n >= 1e3 ? (n / 1e3).toFixed(0) + " K" : String(n ?? 0);
const secs = (ms) => (ms == null ? "—" : (ms / 1000).toFixed(1) + "s");

async function main() {
  let id = process.argv[2];
  let resolvedFrom = "argument";
  if (!id) {
    id = activeTask();
    resolvedFrom = "active session";
  }
  if (!id) {
    console.log("No task provided and no active task found in this session.");
    console.log("Use: /dash_stats PROJ-123");
    return;
  }

  let data;
  try {
    data = taskStats(id);
  } catch (e) {
    console.log(`Could not read the metrics DB: ${e.message}`);
    return;
  }

  const s = data.summary;
  if (!s || !s.messages) {
    console.log(`📋 Task ${id} (${resolvedFrom}): no data recorded yet.`);
    return;
  }
  const tokensTotal = Number(s.tokens_total || 0);
  const errRate = s.tool_uses ? ((s.errors / s.tool_uses) * 100).toFixed(1) : "0.0";

  const L = [];
  L.push(`📋 Stats — task ${id}  (via ${resolvedFrom})`);
  L.push(`${String(s.first_seen).slice(0, 10)} → ${String(s.last_seen).slice(0, 10)}  ·  ${s.days_active} active day(s)  ·  ${s.sessions} session(s)`);
  L.push("");
  L.push(`Total tokens ........ ${compact(tokensTotal)}  (${fmt(tokensTotal)})`);
  L.push(`  input ${fmt(s.tokens_in)} · output ${fmt(s.tokens_out)} · cache_read ${fmt(s.cache_read)} · cache_write ${fmt(s.cache_write)}`);
  L.push(`Messages ............ ${fmt(s.messages)}`);
  L.push(`Tool calls .......... ${fmt(s.tool_uses)}  ·  errors ${fmt(s.errors)} (${errRate}%)`);
  L.push(`Latency ............. p50 ${secs(data.latency.p50_ms)} · p95 ${secs(data.latency.p95_ms)} · avg ${secs(data.latency.avg_ms)}`);
  if (data.by_model?.length) {
    L.push("");
    L.push("By model:");
    for (const m of data.by_model) L.push(`  ${m.model.padEnd(28)} ${compact(Number(m.tokens))}  (${m.messages} msgs)`);
  }
  if (data.top_tools?.length) {
    L.push("");
    L.push("Tools: " + data.top_tools.map((t) => `${t.tool} ${t.uses}`).join(" · "));
  }
  console.log(L.join("\n"));
}

main();
