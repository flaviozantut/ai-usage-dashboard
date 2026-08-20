#!/usr/bin/env node
/**
 * UserPromptSubmit hook — captures the task ID from the user's prompt.
 *
 *   - "#task PROJ-123" / "task: PROJ-123"  → always sets/corrects it (priority)
 *   - PROJ-123 mentioned in the prompt      → sets it if the session has no task yet
 *
 * This way, when SessionStart asked for the ID and the user replies, the task is linked
 * automatically, with no manual step.
 *
 * Register it in ~/.claude/settings.json under UserPromptSubmit.
 */
import { extractTaskId, extractExplicitTask } from "../lib/task.mjs";
import { getTask, setTask } from "../lib/task-state.mjs";

function emit(context) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
    })
  );
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let h = {};
  try {
    h = JSON.parse(raw);
  } catch {}

  const sid = h.session_id ?? "unknown";
  const prompt = h.prompt ?? "";

  const explicit = extractExplicitTask(prompt);
  if (explicit) {
    setTask(sid, explicit, "explicit");
    return emit(`📋 Tarefa da sessão definida como **${explicit}**. Métricas serão vinculadas a ela.`);
  }

  if (!getTask(sid)) {
    const id = extractTaskId(prompt);
    if (id) {
      setTask(sid, id, "prompt");
      return emit(`📋 Tarefa **${id}** detectada e vinculada às métricas desta sessão.`);
    }
  }
}

main().finally(() => process.exit(0));
