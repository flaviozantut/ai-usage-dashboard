#!/usr/bin/env node
/**
 * Hook do Cursor (evento `stop`) — automático, sem coletor manual.
 *
 * O payload do Cursor não traz tokens. Então:
 *   1) SEMPRE registra a atividade do turno na hora (event="stop").
 *   2) SE houver CURSOR_API_KEY, dispara (com throttle) um pull da Admin API que preenche:
 *        - tokens EXATOS (filtered-usage-events)  → eventos "message"
 *        - produtividade diária (daily-usage-data) → eventos "productivity" (accept rate)
 *
 * À prova de falha: nunca quebra o Cursor (exit 0). Idempotente por ext_id.
 *
 * Registre em ~/.cursor/hooks.json (veja hooks/cursor-hooks.example.json).
 * Env: DASH_API, CURSOR_API_KEY (opcional),
 *      CURSOR_LOOKBACK_MIN (default 30), CURSOR_THROTTLE_S (default 120),
 *      DASH_STATE (default ~/.cursor/dash-state)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fetchTokenEvents, fetchDailyProductivity } from "../lib/cursor-api.mjs";
import { extractTaskId } from "../lib/task.mjs";

const API = process.env.DASH_API ?? "http://localhost:8787/events";
const CURSOR_KEY = process.env.CURSOR_API_KEY;
const LOOKBACK = Number(process.env.CURSOR_LOOKBACK_MIN ?? 30) * 60_000;
const THROTTLE = Number(process.env.CURSOR_THROTTLE_S ?? 120) * 1000;
const STATE_DIR = process.env.DASH_STATE ?? join(homedir(), ".cursor", "dash-state");

async function postEvents(events) {
  if (!events.length) return;
  await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(events),
    signal: AbortSignal.timeout(6000),
  });
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
  await postEvents(tokens);
  const prod = await fetchDailyProductivity(CURSOR_KEY, startDate, endDate);
  await postEvents(prod);
  writeFileSync(tsFile, String(Date.now()));
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let h = {};
  try {
    h = JSON.parse(raw);
  } catch {}

  // task_id a partir do branch git do workspace
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

  // 1) atividade do turno (event="stop", não polui a soma de tokens)
  try {
    await postEvents([
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

  // 2) tokens exatos + produtividade via Admin API
  if (CURSOR_KEY) {
    try {
      await pull(h);
    } catch {}
  }
}

main().finally(() => process.exit(0));
