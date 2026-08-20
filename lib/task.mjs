/**
 * Task ID (Jira/issue) extraction — shared by the hooks and the parser.
 *
 * Default pattern: Jira-style key (PROJ-123, AB12-4). Configurable via
 * DASH_TASK_PATTERN (regex, no slashes). The ID is what links each AI session
 * to a tracked task — it's what enables "tokens per issue".
 */
const DEFAULT_PATTERN = "\\b([A-Z][A-Z0-9]{1,9}-\\d+)\\b";

export function taskPattern() {
  return new RegExp(process.env.DASH_TASK_PATTERN ?? DEFAULT_PATTERN, "g");
}

/** Returns the ID if there is exactly ONE distinct match in the text (precision); otherwise null. */
export function extractTaskId(text) {
  if (!text || typeof text !== "string") return null;
  const re = taskPattern();
  const found = new Set();
  let m;
  while ((m = re.exec(text)) !== null) found.add(m[1] ?? m[0]);
  return found.size === 1 ? [...found][0] : null;
}

/** Explicit user marker: "#task PROJ-1", "task: PROJ-1". Takes priority. */
export function extractExplicitTask(text) {
  if (!text || typeof text !== "string") return null;
  const m = text.match(/(?:#\s*task|task\s*:|tarefa\s*:)\s*([A-Za-z][A-Za-z0-9]{1,9}-\d+)/i);
  return m ? m[1].toUpperCase() : null;
}
