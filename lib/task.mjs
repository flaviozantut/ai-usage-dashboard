/**
 * Extração de ID de tarefa (Jira/issue) — compartilhado por hooks e parser.
 *
 * Padrão default: chave estilo Jira (PROJ-123, AB12-4). Configurável via
 * DASH_TASK_PATTERN (regex, sem barras). O ID é o dado que liga cada sessão de IA
 * a uma tarefa de controle — é o que permite "tokens por issue".
 */
const DEFAULT_PATTERN = "\\b([A-Z][A-Z0-9]{1,9}-\\d+)\\b";

export function taskPattern() {
  return new RegExp(process.env.DASH_TASK_PATTERN ?? DEFAULT_PATTERN, "g");
}

/** Retorna o ID se houver exatamente UM distinto no texto (precisão); senão null. */
export function extractTaskId(text) {
  if (!text || typeof text !== "string") return null;
  const re = taskPattern();
  const found = new Set();
  let m;
  while ((m = re.exec(text)) !== null) found.add(m[1] ?? m[0]);
  return found.size === 1 ? [...found][0] : null;
}

/** Marcador explícito do usuário: "#task PROJ-1", "task: PROJ-1". Tem prioridade. */
export function extractExplicitTask(text) {
  if (!text || typeof text !== "string") return null;
  const m = text.match(/(?:#\s*task|task\s*:|tarefa\s*:)\s*([A-Za-z][A-Za-z0-9]{1,9}-\d+)/i);
  return m ? m[1].toUpperCase() : null;
}
