import { basename } from "node:path";
import { extractTaskId } from "./task.mjs";

/**
 * Parser compartilhado de transcript do Claude Code — usado pelo hook (incremental)
 * e pelo coletor de backfill. Recebe uma lista de linhas já parseadas (objetos JSON,
 * em ordem) e devolve os eventos + o último timestamp visto (para latência entre janelas).
 *
 * Eventos emitidos por turno do assistant:
 *   - "message"  : tokens exatos + model + meta{ stop_reason, latency_ms, n_tools, tools,
 *                  web_search, web_fetch, service_tier, gitBranch }
 *   - "tool_use" : um por bloco tool_use (tool = nome) — alimenta top_tools
 *   - "error"    : um por tool_result com is_error (denominador = tool_use) — taxa de erro
 */
export function extractEvents(objs, { prevTs = null, taskId = null } = {}) {
  const events = [];
  let last = prevTs;

  for (const o of objs) {
    const m = o?.message;
    const ts = o?.timestamp;
    // task_id: prioriza o da sessão (explícito/branch no início); senão deriva do branch da linha.
    const task_id = taskId ?? extractTaskId(o?.gitBranch) ?? undefined;

    if (m?.role === "assistant" && m.usage) {
      const u = m.usage;
      const content = Array.isArray(m.content) ? m.content : [];
      const tools = content.filter((b) => b?.type === "tool_use").map((b) => b.name);
      const latency_ms =
        last && ts ? Math.max(0, new Date(ts) - new Date(last)) : null;
      const project = o.cwd ? basename(o.cwd) : undefined;

      events.push({
        source: "claude-code",
        session_id: o.sessionId ?? "unknown",
        user: "self",
        event: "message",
        project,
        task_id,
        model: m.model,
        tokens_in: u.input_tokens ?? 0,
        tokens_out: u.output_tokens ?? 0,
        cache_read: u.cache_read_input_tokens ?? 0,
        cache_write: u.cache_creation_input_tokens ?? 0,
        ext_id: o.uuid,
        ts,
        meta: {
          stop_reason: m.stop_reason ?? null,
          latency_ms,
          n_tools: tools.length,
          tools,
          web_search: u.server_tool_use?.web_search_requests ?? 0,
          web_fetch: u.server_tool_use?.web_fetch_requests ?? 0,
          service_tier: u.service_tier ?? null,
          gitBranch: o.gitBranch ?? null,
        },
      });

      tools.forEach((name, i) => {
        events.push({
          source: "claude-code",
          session_id: o.sessionId ?? "unknown",
          user: "self",
          event: "tool_use",
          tool: name,
          project,
          task_id,
          model: m.model,
          ext_id: `${o.uuid}:t${i}`,
          ts,
          meta: {},
        });
      });
    }

    // erros de ferramenta vêm nos tool_result das mensagens "user"
    if (m?.role === "user" && Array.isArray(m.content)) {
      m.content.forEach((b, i) => {
        if (b?.type === "tool_result" && b.is_error === true) {
          events.push({
            source: "claude-code",
            session_id: o.sessionId ?? "unknown",
            user: "self",
            event: "error",
            project: o.cwd ? basename(o.cwd) : undefined,
            task_id,
            ext_id: `${o.uuid}:e${i}`,
            ts,
            meta: { tool_use_id: b.tool_use_id ?? null },
          });
        }
      });
    }

    if (ts) last = ts;
  }

  return { events, lastTs: last };
}
