import { createHash } from "node:crypto";

/**
 * Shared client for the Cursor Admin API — used by the hook and by the backfill.
 * Two endpoints:
 *   - filtered-usage-events : EXACT tokens per event  → "message" events
 *   - daily-usage-data      : daily productivity        → "productivity" events
 *                             (accepted/rejected lines, tabs, applies → accept rate)
 */

function basicAuth(key) {
  return "Basic " + Buffer.from(`${key}:`).toString("base64");
}

function extId(e) {
  const raw = [e.timestamp, e.conversationId, e.model, e.userEmail, e.chargedCents].join("|");
  return "cursor:" + createHash("sha1").update(raw).digest("hex").slice(0, 24);
}

/** Exact tokens → "message" events. Paginated. Optional `userEmail` filters to the owner. */
export async function fetchTokenEvents(key, startDate, endDate, userEmail = null) {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const res = await fetch("https://api.cursor.com/teams/filtered-usage-events", {
      method: "POST",
      headers: { Authorization: basicAuth(key), "Content-Type": "application/json" },
      body: JSON.stringify({ startDate, endDate, page, pageSize: 1000 }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`filtered-usage-events ${res.status}: ${await res.text()}`);
    const rows = (await res.json()).usageEvents ?? [];
    for (const e of rows) {
      if (userEmail && e.userEmail && e.userEmail !== userEmail) continue;
      const tu = e.tokenUsage ?? {};
      out.push({
        source: "cursor",
        session_id: e.conversationId ?? "unknown",
        user: "self",
        event: "message",
        model: e.model,
        tokens_in: tu.inputTokens ?? 0,
        tokens_out: tu.outputTokens ?? 0,
        cache_read: tu.cacheReadTokens ?? 0,
        cache_write: tu.cacheWriteTokens ?? 0,
        cost_usd: e.chargedCents != null ? e.chargedCents / 100 : undefined,
        ext_id: extId(e),
        ts: new Date(Number(e.timestamp)).toISOString(),
        meta: { cursorEmail: e.userEmail, kind: e.kind, isHeadless: e.isHeadless },
      });
    }
    if (rows.length < 1000) break;
  }
  return out;
}

/** Daily productivity → "productivity" events (line and tab accept rate). */
export async function fetchDailyProductivity(key, startDate, endDate) {
  const res = await fetch("https://api.cursor.com/teams/daily-usage-data", {
    method: "POST",
    headers: { Authorization: basicAuth(key), "Content-Type": "application/json" },
    body: JSON.stringify({ startDate, endDate }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`daily-usage-data ${res.status}: ${await res.text()}`);
  const rows = (await res.json()).data ?? [];
  return rows.map((r) => ({
    source: "cursor",
    session_id: `daily:${r.day}`,
    user: "self",
    event: "productivity",
    model: r.mostUsedModel ?? undefined,
    ext_id: `cursor-daily:${r.userId}:${r.day}`,
    ts: new Date(r.date ?? r.day).toISOString(),
    meta: {
      email: r.email,
      day: r.day,
      linesAdded: r.totalLinesAdded ?? 0,
      linesDeleted: r.totalLinesDeleted ?? 0,
      acceptedLinesAdded: r.acceptedLinesAdded ?? 0,
      acceptedLinesDeleted: r.acceptedLinesDeleted ?? 0,
      applies: r.totalApplies ?? 0,
      accepts: r.totalAccepts ?? 0,
      rejects: r.totalRejects ?? 0,
      tabsShown: r.totalTabsShown ?? 0,
      tabsAccepted: r.totalTabsAccepted ?? 0,
      chatRequests: r.chatRequests ?? 0,
      agentRequests: r.agentRequests ?? 0,
      composerRequests: r.composerRequests ?? 0,
    },
  }));
}
