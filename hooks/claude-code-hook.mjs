#!/usr/bin/env node
/**
 * Claude Code hook — EXACT TOKENS + tools + stop_reason + latency.
 * Automatic on Stop/SubagentStop, no manual collector.
 *
 * Tails the transcript (only what grew, via per-file state) and uses the shared parser
 * lib/claude-transcript.mjs to extract message/tool_use/error from each turn.
 *
 * Fail-safe: never blocks Claude Code (exit 0). Idempotent by ext_id.
 *
 * Writes straight to the local SQLite DB — no server to keep running.
 *
 * Env: IA_USAGE_DASHBOARD_DB_PATH (SQLite file), DASH_STATE (dir; default ~/.claude/dash-state)
 */
import { openSync, readSync, closeSync, statSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { extractEvents } from "../lib/claude-transcript.mjs";
import { getTask } from "../lib/task-state.mjs";
import { insertEvents } from "../lib/db.mjs";

const STATE_DIR = process.env.DASH_STATE ?? join(homedir(), ".claude", "dash-state");

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw) return;

  let h;
  try {
    h = JSON.parse(raw);
  } catch {
    return;
  }
  const tpath = h.transcript_path;
  if (!tpath) return;

  let size;
  try {
    size = statSync(tpath).size;
  } catch {
    return;
  }

  mkdirSync(STATE_DIR, { recursive: true });
  const stateFile = join(STATE_DIR, createHash("sha1").update(tpath).digest("hex") + ".json");
  let state = { off: 0, ts: null };
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {}
  let offset = state.off ?? 0;
  if (offset > size) offset = 0; // file replaced/truncated
  if (offset === size) return; // nothing new

  const len = size - offset;
  const buf = Buffer.alloc(len);
  const fd = openSync(tpath, "r");
  readSync(fd, buf, 0, len, offset);
  closeSync(fd);
  const text = buf.toString("utf8");

  // only complete lines (terminated by \n)
  const parts = text.split("\n");
  const complete = parts.slice(0, -1);
  let consumed = 0;
  const objs = [];
  for (const line of complete) {
    consumed += Buffer.byteLength(line, "utf8") + 1;
    if (!line.trim()) continue;
    try {
      objs.push(JSON.parse(line));
    } catch {}
  }

  const task = getTask(h.session_id);
  const { events, lastTs } = extractEvents(objs, {
    prevTs: state.ts,
    taskId: task?.task_id ?? null,
  });

  if (events.length) {
    try {
      insertEvents(events);
    } catch {
      return; // write failure: don't advance the offset, retry next turn
    }
  }

  try {
    writeFileSync(stateFile, JSON.stringify({ off: offset + consumed, ts: lastTs }));
  } catch {}
}

main().finally(() => process.exit(0));
