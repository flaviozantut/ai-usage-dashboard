import { basename } from "node:path";
import { extractTaskId } from "./task.mjs";

/**
 * Shared Claude Code transcript parser — used by the hook (incremental) and by the
 * backfill collector. Takes a list of already-parsed lines (JSON objects, in order)
 * and returns the events + the last timestamp seen (for latency across windows).
 *
 * Events emitted per assistant turn:
 *   - "message"  : exact tokens + model + meta{ stop_reason, latency_ms, n_tools, tools,
 *                  web_search, web_fetch, service_tier, gitBranch }
 *   - "tool_use" : one per tool_use block (tool = name) — feeds top_tools
 *   - "error"    : one per tool_result with is_error (denominator = tool_use) — error rate
 */
export function extractEvents(objs, { prevTs = null, taskId = null } = {}) {
  const events = [];
  let last = prevTs;

  for (const o of objs) {
    const m = o?.message;
    const ts = o?.timestamp;
    // task_id: prefer the session's (explicit/branch at start); otherwise derive from the line's branch.
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

    // tool errors come in the tool_result blocks of "user" messages
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
