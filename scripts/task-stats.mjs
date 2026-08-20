#!/usr/bin/env node
/**
 * Stats for a task — used by the /dash_stats slash command.
 *
 *   node task-stats.mjs DEMO-100   → stats for the given task
 *   node task-stats.mjs            → stats for the ACTIVE task of the current session
 *                                    (most recent task state file)
 *
 * Env: DASH_API (default http://localhost:8787/events), DASH_STATE.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Config: env takes priority; otherwise reads ~/.claude/dash-state/config.json.
function fileConfig() {
  try {
    return JSON.parse(
      readFileSync(join(homedir(), ".claude", "dash-state", "config.json"), "utf8")
    );
  } catch {
    return {};
  }
}
const CFG = fileConfig();
const API_BASE = (process.env.DASH_API ?? CFG.api ?? "http://localhost:8787/events").replace(
  /\/events\/?$/,
  ""
);
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

const fmt = (n) => (n ?? 0).toLocaleString("pt-BR");
const compact = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + " B" : n >= 1e6 ? (n / 1e6).toFixed(1) + " M" : n >= 1e3 ? (n / 1e3).toFixed(0) + " K" : String(n ?? 0);
const secs = (ms) => (ms == null ? "—" : (ms / 1000).toFixed(1) + "s");

async function main() {
  let id = process.argv[2];
  let resolvedFrom = "argumento";
  if (!id) {
    id = activeTask();
    resolvedFrom = "sessão ativa";
  }
  if (!id) {
    console.log("Nenhuma tarefa informada e nenhuma tarefa ativa encontrada nesta sessão.");
    console.log("Use: /dash_stats PROJ-123");
    return;
  }

  let data;
  try {
    const res = await fetch(`${API_BASE}/stats/task?id=${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.log(`Erro ao consultar (${res.status}). API em ${API_BASE} está no ar?`);
      return;
    }
    data = await res.json();
  } catch (e) {
    console.log(`Não foi possível falar com a API em ${API_BASE}: ${e.message}`);
    return;
  }

  const s = data.summary;
  if (!s || !s.messages) {
    console.log(`📋 Tarefa ${id} (${resolvedFrom}): nenhum dado registrado ainda.`);
    return;
  }
  const tokensTotal = Number(s.tokens_total || 0);
  const errRate = s.tool_uses ? ((s.errors / s.tool_uses) * 100).toFixed(1) : "0,0";

  const L = [];
  L.push(`📋 Estatísticas — tarefa ${id}  (via ${resolvedFrom})`);
  L.push(`${String(s.first_seen).slice(0, 10)} → ${String(s.last_seen).slice(0, 10)}  ·  ${s.days_active} dia(s) ativo(s)  ·  ${s.sessions} sessão(ões)`);
  L.push("");
  L.push(`Tokens totais ....... ${compact(tokensTotal)}  (${fmt(tokensTotal)})`);
  L.push(`  input ${fmt(s.tokens_in)} · output ${fmt(s.tokens_out)} · cache_read ${fmt(s.cache_read)} · cache_write ${fmt(s.cache_write)}`);
  L.push(`Mensagens ........... ${fmt(s.messages)}`);
  L.push(`Chamadas de tool .... ${fmt(s.tool_uses)}  ·  erros ${fmt(s.errors)} (${errRate}%)`);
  L.push(`Latência ............ p50 ${secs(data.latency.p50_ms)} · p95 ${secs(data.latency.p95_ms)} · média ${secs(data.latency.avg_ms)}`);
  if (data.by_model?.length) {
    L.push("");
    L.push("Por modelo:");
    for (const m of data.by_model) L.push(`  ${m.model.padEnd(28)} ${compact(Number(m.tokens))}  (${m.messages} msgs)`);
  }
  if (data.top_tools?.length) {
    L.push("");
    L.push("Ferramentas: " + data.top_tools.map((t) => `${t.tool} ${t.uses}`).join(" · "));
  }
  console.log(L.join("\n"));
}

main();
