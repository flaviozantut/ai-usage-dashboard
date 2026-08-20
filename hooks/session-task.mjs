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
      return emit(`📋 This session's metrics are linked to task **${id}** (via .dash-task).`);
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
    return emit(`📋 This session's metrics are linked to task **${fromBranch}** (detected from branch \`${branch}\`).`);
  }

  // 3) not identified precisely → ask the user
  emit(
    `📋 Task tracking: could not precisely identify which task ` +
      `(Jira/issue) this session refers to` +
      (branch ? ` — branch \`${branch}\` does not contain a recognizable task ID.` : `.`) +
      ` BEFORE starting the work, ask the user for this session's task ID ` +
      `(e.g. PROJ-123). When the user replies, confirm by repeating the ID; it will be ` +
      `captured automatically and linked to the metrics. The user can also provide it ` +
      `at any time by writing "#task PROJ-123".`
  );
}

main().finally(() => process.exit(0));
