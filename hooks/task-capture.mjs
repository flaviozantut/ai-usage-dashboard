#!/usr/bin/env node
/**
 * Hook UserPromptSubmit — captura o ID da tarefa a partir do prompt do usuário.
 *
 *   - "#task PROJ-123" / "task: PROJ-123"  → define/corrige sempre (prioridade)
 *   - PROJ-123 mencionado no prompt         → define se a sessão ainda não tem tarefa
 *
 * Assim, quando o SessionStart pediu o ID e o usuário responde, a tarefa é vinculada
 * sozinha, sem passo manual.
 *
 * Registre no ~/.claude/settings.json em UserPromptSubmit.
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
