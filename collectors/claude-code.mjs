#!/usr/bin/env node
/**
 * Claude Code backfill (runs once, optional) — EXACT TOKENS + tools +
 * stop_reason + latency. Scans ~/.claude/projects/**.jsonl and uses the same parser as
 * the hook (lib/claude-transcript.mjs). Idempotent by ext_id.
 *
 * Writes straight to the local SQLite DB — no server needed.
 *
 * Env: IA_USAGE_DASHBOARD_DB_PATH (SQLite file), CLAUDE_DIR (default ~/.claude/projects)
 */
import { readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { homedir } from "node:os";
import { extractEvents } from "../lib/claude-transcript.mjs";
import { insertEvents } from "../lib/db.mjs";

const ROOT = process.env.CLAUDE_DIR ?? join(homedir(), ".claude", "projects");
const BATCH = 500;

async function* jsonlFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* jsonlFiles(p);
    else if (e.name.endsWith(".jsonl")) yield p;
  }
}

function post(batch) {
  return insertEvents(batch);
}

let sent = 0,
  inserted = 0,
  batch = [];

for await (const file of jsonlFiles(ROOT)) {
  const objs = [];
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      objs.push(JSON.parse(line));
    } catch {}
  }
  // latency within the file (prevTs restarts per file/session)
  const { events } = extractEvents(objs, { prevTs: null });
  for (const ev of events) {
    batch.push(ev);
    if (batch.length >= BATCH) {
      inserted += await post(batch);
      sent += batch.length;
      batch = [];
    }
  }
}
if (batch.length) {
  inserted += await post(batch);
  sent += batch.length;
}

console.log(`claude-code backfill: ${sent} events sent, ${inserted} new ones written.`);
