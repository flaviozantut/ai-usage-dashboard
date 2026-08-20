import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { IngestSchema } from "./types.js";
import { insertEvents, taskStats } from "./db.js";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

// Stats for a task (used by /dash_stats). Local app, no auth.
app.get("/stats/task", (c) => {
  const id = c.req.query("id");
  if (!id) return c.json({ error: "missing id" }, 400);
  return c.json(taskStats(id));
});

/**
 * Ingestion. Local app, no auth — `user` comes from the payload itself.
 */
app.post("/events", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }

  const parsed = IngestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation", details: parsed.error.flatten() }, 422);
  }

  const events = Array.isArray(parsed.data) ? parsed.data : [parsed.data];

  const n = insertEvents(events);
  return c.json({ inserted: n });
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`[ingest] listening on http://localhost:${port}`);
