#!/usr/bin/env node
/**
 * Backfill do Claude Code (roda uma vez, opcional) — TOKENS EXATOS + ferramentas +
 * stop_reason + latência. Varre ~/.claude/projects/**.jsonl e usa o mesmo parser do hook
 * (lib/claude-transcript.mjs). Idempotente por ext_id.
 *
 * Env: DASH_API, CLAUDE_DIR (default ~/.claude/projects)
 */
import { readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { homedir } from "node:os";
import { extractEvents } from "../lib/claude-transcript.mjs";

const API = process.env.DASH_API ?? "http://localhost:8787/events";
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

async function post(batch) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(batch),
  });
  if (!res.ok) throw new Error(`POST ${res.status}: ${await res.text()}`);
  return (await res.json()).inserted;
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
  // latência dentro do arquivo (prevTs recomeça por arquivo/sessão)
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

console.log(`claude-code backfill: ${sent} eventos enviados, ${inserted} novos gravados.`);
