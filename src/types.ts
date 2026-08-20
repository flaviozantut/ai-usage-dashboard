import { z } from "zod";

/**
 * The event contract. It's the heart of the system — collection, ingestion and
 * querying all depend on this schema. Keep it stable and add free-form fields in `meta`.
 *
 * Tokens are first-class fields (not stored in `meta`) because they are the central
 * metric: they must be summable and filterable efficiently.
 *
 * Source of the EXACT tokens:
 *   - claude-code: message.usage in the transcripts ~/.claude/projects/**.jsonl
 *   - cursor:      Admin API POST https://api.cursor.com/teams/filtered-usage-events
 */
export const EventSchema = z.object({
  ts: z.string().datetime().optional(), // ISO 8601; if absent, the server stamps it
  source: z.enum(["claude-code", "cursor", "other"]),
  session_id: z.string().min(1),
  user: z.string().min(1),
  event: z.enum([
    "session_start",
    "prompt",
    "tool_use",
    "message", // assistant turn — carries the tokens
    "productivity", // Cursor daily aggregate: accepted/rejected lines, tabs
    "stop",
    "error",
  ]),
  tool: z.string().optional(), // when event === "tool_use"
  project: z.string().optional(),
  task_id: z.string().optional(), // task/issue (Jira etc.) linked to the session
  model: z.string().optional(), // when event === "message"

  // Exact (billed) tokens. All optional; 0 when not applicable.
  tokens_in: z.number().int().nonnegative().default(0),
  tokens_out: z.number().int().nonnegative().default(0),
  cache_read: z.number().int().nonnegative().default(0),
  cache_write: z.number().int().nonnegative().default(0),
  cost_usd: z.number().nonnegative().optional(), // when the source provides it (Cursor API)

  // Idempotency: stable id from the source (requestId etc.) to avoid duplicates on re-scan.
  ext_id: z.string().optional(),

  meta: z.record(z.unknown()).default({}),
});

export type Event = z.infer<typeof EventSchema>;

// Accepts a single event or a batch (collectors send in batches).
export const IngestSchema = z.union([EventSchema, z.array(EventSchema)]);
