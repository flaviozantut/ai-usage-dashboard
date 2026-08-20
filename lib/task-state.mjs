/**
 * Session → task state. One small file per session in DASH_STATE/tasks/.
 * SessionStart resolves it, UserPromptSubmit captures/corrects it, and Stop reads it
 * to stamp every event with the task_id.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function dir() {
  const base = process.env.DASH_STATE ?? join(homedir(), ".claude", "dash-state");
  const d = join(base, "tasks");
  mkdirSync(d, { recursive: true });
  return d;
}

function file(sessionId) {
  return join(dir(), (sessionId || "unknown").replace(/[^A-Za-z0-9_-]/g, "_") + ".json");
}

export function getTask(sessionId) {
  try {
    return JSON.parse(readFileSync(file(sessionId), "utf8"));
  } catch {
    return null;
  }
}

export function setTask(sessionId, taskId, source) {
  const rec = { task_id: taskId, source, at: new Date().toISOString() };
  try {
    writeFileSync(file(sessionId), JSON.stringify(rec));
  } catch {}
  return rec;
}
