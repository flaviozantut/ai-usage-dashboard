import { z } from "zod";

/**
 * Contrato do evento. É o coração do sistema — coleta, ingestão e consulta
 * dependem todos deste schema. Mantenha-o estável e adicione campos livres em `meta`.
 *
 * Tokens são campos de primeira classe (não ficam em `meta`) porque são a métrica
 * central: precisam ser somáveis e filtráveis com eficiência.
 *
 * Origem dos tokens EXATOS:
 *   - claude-code: message.usage nos transcripts ~/.claude/projects/**.jsonl
 *   - cursor:      Admin API POST https://api.cursor.com/teams/filtered-usage-events
 */
export const EventSchema = z.object({
  ts: z.string().datetime().optional(), // ISO 8601; se ausente, o servidor carimba
  source: z.enum(["claude-code", "cursor", "other"]),
  session_id: z.string().min(1),
  user: z.string().min(1),
  event: z.enum([
    "session_start",
    "prompt",
    "tool_use",
    "message", // turno do assistant — carrega os tokens
    "productivity", // agregado diário do Cursor: linhas aceitas/rejeitadas, tabs
    "stop",
    "error",
  ]),
  tool: z.string().optional(), // quando event === "tool_use"
  project: z.string().optional(),
  task_id: z.string().optional(), // tarefa/issue (Jira etc.) vinculada à sessão
  model: z.string().optional(), // quando event === "message"

  // Tokens exatos (faturados). Todos opcionais; 0 quando não aplicável.
  tokens_in: z.number().int().nonnegative().default(0),
  tokens_out: z.number().int().nonnegative().default(0),
  cache_read: z.number().int().nonnegative().default(0),
  cache_write: z.number().int().nonnegative().default(0),
  cost_usd: z.number().nonnegative().optional(), // quando a fonte fornece (Cursor API)

  // Idempotência: id estável da fonte (requestId etc.) para não duplicar no re-scan.
  ext_id: z.string().optional(),

  meta: z.record(z.unknown()).default({}),
});

export type Event = z.infer<typeof EventSchema>;

// Aceita um evento único ou um lote (coletores mandam em lote).
export const IngestSchema = z.union([EventSchema, z.array(EventSchema)]);
