#!/usr/bin/env node
/**
 * Hook do Claude Code — TOKENS EXATOS + ferramentas + stop_reason + latência.
 * Automático no Stop/SubagentStop, sem coletor manual.
 *
 * Faz o "tail" do transcript (só o que cresceu, via estado por arquivo) e usa o parser
 * compartilhado lib/claude-transcript.mjs pra extrair message/tool_use/error de cada turno.
 *
 * À prova de falha: nunca bloqueia o Claude Code (exit 0). Idempotente por ext_id.
 *
 * Env: DASH_API, DASH_STATE (dir; default ~/.claude/dash-state)
 */
import { openSync, readSync, closeSync, statSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { extractEvents } from "../lib/claude-transcript.mjs";
import { getTask } from "../lib/task-state.mjs";

const API = process.env.DASH_API ?? "http://localhost:8787/events";
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
  if (offset > size) offset = 0; // arquivo trocado/truncado
  if (offset === size) return; // nada novo

  const len = size - offset;
  const buf = Buffer.alloc(len);
  const fd = openSync(tpath, "r");
  readSync(fd, buf, 0, len, offset);
  closeSync(fd);
  const text = buf.toString("utf8");

  // só linhas completas (terminadas em \n)
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
      await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(events),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      return; // falha de rede: não avança o offset, tenta no próximo turno
    }
  }

  try {
    writeFileSync(stateFile, JSON.stringify({ off: offset + consumed, ts: lastTs }));
  } catch {}
}

main().finally(() => process.exit(0));
