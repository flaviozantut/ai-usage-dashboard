#!/usr/bin/env node
/**
 * SessionStart hook — resolves the session's TASK (Jira/issue).
 *
 * Precedence order: .dash-task file in the repo → git branch → (nothing) ask the user.
 * When it resolves, it writes the session→task state. When it can't resolve precisely, it
 * injects context instructing Claude to ask the user for the ID before proceeding.
 *
 * Register it in ~/.claude/settings.json under SessionStart.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { extractTaskId } from "../lib/task.mjs";
import { getTask, setTask } from "../lib/task-state.mjs";

function emit(context) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
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
  const cwd = h.cwd ?? process.cwd();

  // already resolved in this session? do nothing.
  if (getTask(sid)) return;

  // 1) explicit override in the repo
  try {
    const t = readFileSync(join(cwd, ".dash-task"), "utf8").trim();
    const id = extractTaskId(t) ?? (t ? t.split(/\s+/)[0] : null);
    if (id) {
      setTask(sid, id, "file");
      return emit(`📋 Métricas desta sessão vinculadas à tarefa **${id}** (via .dash-task).`);
    }
  } catch {}

  // 2) git branch
  let branch = "";
  try {
    branch = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {}
  const fromBranch = extractTaskId(branch);
  if (fromBranch) {
    setTask(sid, fromBranch, "branch");
    return emit(`📋 Métricas desta sessão vinculadas à tarefa **${fromBranch}** (detectada no branch \`${branch}\`).`);
  }

  // 3) not identified precisely → ask the user
  emit(
    `📋 Rastreamento de tarefa: não foi possível identificar com precisão a qual tarefa ` +
      `(Jira/issue) esta sessão se refere` +
      (branch ? ` — o branch \`${branch}\` não contém um ID de tarefa reconhecível.` : `.`) +
      ` ANTES de começar o trabalho, pergunte ao usuário qual é o ID da tarefa desta sessão ` +
      `(ex.: PROJ-123). Quando o usuário responder, confirme repetindo o ID; ele será ` +
      `capturado automaticamente e vinculado às métricas. O usuário também pode informar ` +
      `a qualquer momento escrevendo "#task PROJ-123".`
  );
}

main().finally(() => process.exit(0));
