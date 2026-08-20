import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { db } from "./db.js";

/**
 * READ-ONLY MCP server. Claude and Cursor call these tools and get back clean JSON
 * ready to become a chart (artifact in Claude, canvas in Cursor).
 * They never talk to the database directly.
 */
const server = new McpServer({ name: "ai-usage-metrics", version: "0.1.0" });

// Time window reused by every tool.
const period = z
  .enum(["24h", "7d", "30d", "all"])
  .default("7d")
  .describe("Time window of the query");

function sinceClause(p: string): string {
  const map: Record<string, string> = {
    "24h": "-1 day",
    "7d": "-7 days",
    "30d": "-30 days",
  };
  return p === "all" ? "1=1" : `ts >= datetime('now', '${map[p]}')`;
}

server.tool(
  "query_usage",
  "Event counts over time, groupable by day/user/project/tool/source.",
  {
    period,
    group_by: z
      .enum(["day", "user", "project", "task_id", "tool", "source", "event"])
      .default("day"),
    user: z.string().optional().describe("Filter by a single user"),
  },
  async ({ period, group_by, user }) => {
    const col = group_by === "day" ? "date(ts)" : group_by;
    const where = [sinceClause(period)];
    const params: (string | number)[] = [];
    if (user) {
      where.push("user = ?");
      params.push(user);
    }
    const rows = db
      .prepare(
        `SELECT ${col} AS bucket, COUNT(*) AS count
         FROM events WHERE ${where.join(" AND ")}
         GROUP BY bucket ORDER BY bucket`
      )
      .all(...params);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

server.tool(
  "top_tools",
  "Most-used tools (event = tool_use) in the window.",
  { period, limit: z.number().int().min(1).max(50).default(10) },
  async ({ period, limit }) => {
    const rows = db
      .prepare(
        `SELECT tool, COUNT(*) AS count
         FROM events
         WHERE event = 'tool_use' AND tool IS NOT NULL AND ${sinceClause(period)}
         GROUP BY tool ORDER BY count DESC LIMIT ?`
      )
      .all(limit);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

server.tool(
  "sessions_summary",
  "Per-session summary: event count, tools, first/last event, duration.",
  { period, limit: z.number().int().min(1).max(200).default(50) },
  async ({ period, limit }) => {
    const rows = db
      .prepare(
        `SELECT session_id, user, project,
                COUNT(*) AS events,
                SUM(event = 'tool_use') AS tool_uses,
                MIN(ts) AS started, MAX(ts) AS ended,
                CAST((julianday(MAX(ts)) - julianday(MIN(ts))) * 86400 AS INT) AS duration_s
         FROM events WHERE ${sinceClause(period)}
         GROUP BY session_id ORDER BY started DESC LIMIT ?`
      )
      .all(limit);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

server.tool(
  "token_usage",
  "Sum of EXACT tokens (in/out/cache) and cost, groupable by day/model/source/user/project.",
  {
    period,
    group_by: z
      .enum(["day", "model", "source", "user", "project", "task_id"])
      .default("day"),
    source: z.enum(["claude-code", "cursor"]).optional(),
  },
  async ({ period, group_by, source }) => {
    const col = group_by === "day" ? "date(ts)" : group_by;
    const where = [sinceClause(period), "event = 'message'"];
    const params: (string | number)[] = [];
    if (source) {
      where.push("source = ?");
      params.push(source);
    }
    const rows = db
      .prepare(
        `SELECT ${col} AS bucket,
                SUM(tokens_in)   AS tokens_in,
                SUM(tokens_out)  AS tokens_out,
                SUM(cache_read)  AS cache_read,
                SUM(cache_write) AS cache_write,
                SUM(tokens_in + tokens_out + cache_read + cache_write) AS total,
                ROUND(SUM(COALESCE(cost_usd, 0)), 4) AS cost_usd,
                COUNT(*) AS messages
         FROM events WHERE ${where.join(" AND ")}
         GROUP BY bucket ORDER BY bucket`
      )
      .all(...params);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

server.tool(
  "latency_stats",
  "Per-turn latency (ms between trigger and response): avg, p50, p95, max — by day or model.",
  { period, group_by: z.enum(["day", "model"]).default("day") },
  async ({ period, group_by }) => {
    const col = group_by === "day" ? "date(ts)" : "model";
    const rows = db
      .prepare(
        `SELECT ${col} AS bucket, json_extract(meta,'$.latency_ms') AS lat
         FROM events
         WHERE event='message' AND ${sinceClause(period)}
           AND json_extract(meta,'$.latency_ms') IS NOT NULL`
      )
      .all() as { bucket: string; lat: number }[];
    const groups = new Map<string, number[]>();
    for (const r of rows) {
      if (!groups.has(r.bucket)) groups.set(r.bucket, []);
      groups.get(r.bucket)!.push(r.lat);
    }
    const pct = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))];
    const out = [...groups.entries()]
      .map(([bucket, a]) => {
        a.sort((x, y) => x - y);
        const avg = Math.round(a.reduce((s, v) => s + v, 0) / a.length);
        return { bucket, turns: a.length, avg_ms: avg, p50_ms: pct(a, 0.5), p95_ms: pct(a, 0.95), max_ms: a[a.length - 1] };
      })
      .sort((x, y) => (x.bucket < y.bucket ? -1 : 1));
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
);

server.tool(
  "tool_stats",
  "Most-used tools + error rate (errors/use) + web search/fetch calls, in the window.",
  { period, limit: z.number().int().min(1).max(50).default(15) },
  async ({ period, limit }) => {
    const tools = db
      .prepare(
        `SELECT tool, COUNT(*) AS uses FROM events
         WHERE event='tool_use' AND tool IS NOT NULL AND ${sinceClause(period)}
         GROUP BY tool ORDER BY uses DESC LIMIT ?`
      )
      .all(limit);
    const totals = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM events WHERE event='tool_use' AND ${sinceClause(period)}) AS tool_uses,
           (SELECT COUNT(*) FROM events WHERE event='error'    AND ${sinceClause(period)}) AS errors,
           (SELECT COALESCE(SUM(json_extract(meta,'$.web_search')),0) FROM events WHERE event='message' AND ${sinceClause(period)}) AS web_search,
           (SELECT COALESCE(SUM(json_extract(meta,'$.web_fetch')),0)  FROM events WHERE event='message' AND ${sinceClause(period)}) AS web_fetch`
      )
      .get() as { tool_uses: number; errors: number; web_search: number; web_fetch: number };
    const error_rate = totals.tool_uses ? +(totals.errors / totals.tool_uses).toFixed(4) : 0;
    return {
      content: [
        { type: "text", text: JSON.stringify({ summary: { ...totals, error_rate }, top_tools: tools }, null, 2) },
      ],
    };
  }
);

server.tool(
  "stop_reasons",
  "Distribution of turn stop_reason (end_turn, tool_use, max_tokens, refusal) — flags truncations and refusals.",
  { period },
  async ({ period }) => {
    const rows = db
      .prepare(
        `SELECT json_extract(meta,'$.stop_reason') AS stop_reason, COUNT(*) AS count
         FROM events WHERE event='message' AND ${sinceClause(period)}
         GROUP BY stop_reason ORDER BY count DESC`
      )
      .all();
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

server.tool(
  "productivity",
  "Cursor: code and tab accept rate, accepted/rejected lines, by day or user.",
  { period, group_by: z.enum(["day", "user"]).default("day") },
  async ({ period, group_by }) => {
    const col = group_by === "day" ? "json_extract(meta,'$.day')" : "json_extract(meta,'$.email')";
    const rows = db
      .prepare(
        `SELECT ${col} AS bucket,
                SUM(json_extract(meta,'$.linesAdded'))         AS lines_added,
                SUM(json_extract(meta,'$.acceptedLinesAdded')) AS lines_accepted,
                SUM(json_extract(meta,'$.tabsShown'))          AS tabs_shown,
                SUM(json_extract(meta,'$.tabsAccepted'))       AS tabs_accepted,
                SUM(json_extract(meta,'$.accepts'))            AS accepts,
                SUM(json_extract(meta,'$.rejects'))            AS rejects
         FROM events WHERE event='productivity' AND ${sinceClause(period)}
         GROUP BY bucket ORDER BY bucket`
      )
      .all() as Record<string, number>[];
    const out = rows.map((r) => ({
      ...r,
      line_accept_rate: r.lines_added ? +(r.lines_accepted / r.lines_added).toFixed(3) : null,
      tab_accept_rate: r.tabs_shown ? +(r.tabs_accepted / r.tabs_shown).toFixed(3) : null,
    }));
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
);

server.tool(
  "by_task",
  "AI effort per task/issue (Jira etc.): tokens, messages, tools, errors and sessions.",
  { period, limit: z.number().int().min(1).max(100).default(30) },
  async ({ period, limit }) => {
    const rows = db
      .prepare(
        `SELECT task_id,
                COUNT(DISTINCT session_id) AS sessions,
                SUM(event='message')  AS messages,
                SUM(event='tool_use') AS tool_uses,
                SUM(event='error')    AS errors,
                SUM(tokens_in+tokens_out+cache_read+cache_write) AS tokens,
                MIN(ts) AS first_seen, MAX(ts) AS last_seen
         FROM events
         WHERE task_id IS NOT NULL AND ${sinceClause(period)}
         GROUP BY task_id ORDER BY tokens DESC LIMIT ?`
      )
      .all(limit);
    const untracked = db
      .prepare(
        `SELECT COUNT(DISTINCT session_id) AS sessions,
                SUM(tokens_in+tokens_out+cache_read+cache_write) AS tokens
         FROM events WHERE task_id IS NULL AND event='message' AND ${sinceClause(period)}`
      )
      .get();
    return {
      content: [
        { type: "text", text: JSON.stringify({ by_task: rows, untracked }, null, 2) },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
