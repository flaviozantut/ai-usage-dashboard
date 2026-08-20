# AI Usage Dash

Dashboard of AI usage metrics at work, focused on **exact (billed) tokens**,
collected **automatically by hooks during the session** — you don't run any collector,
**and there is no server to keep running.**

Three independent layers:

1. **Collection (via hooks)** — end-of-turn hooks write the exact usage **straight to the local SQLite file** ([lib/db.mjs](lib/db.mjs)). No daemon, no HTTP.
2. **Storage** — a single SQLite file (`metrics.db`) via Node's built-in `node:sqlite` (no native dependency, no build step). WAL + `busy_timeout` let concurrent hook writers and the MCP reader share it safely.
3. **Query/analysis** — a read-only MCP server (stdio, spawned on demand by the client) that Claude and Cursor consume to generate charts (artifacts / canvas).

The event contract ([src/types.ts](src/types.ts)) ties the three layers together. Tokens are first-class fields.

## How the exact token arrives, automatically

Runs **100% local** on your machine — the hooks are short-lived `node` processes that open
the SQLite file, write the turn's events, and exit. Nothing listens on a port.

| Client | Hook | What it does | Requires |
|--------|------|--------------|----------|
| **Claude Code** | `Stop` → [hooks/claude-code-hook.mjs](hooks/claude-code-hook.mjs) | Reads `transcript_path` each turn, tails the transcript and extracts `message.usage` (**exact** in/out/cache) | nothing — 100% local |
| **Cursor** | `stop` → [hooks/cursor-hook.mjs](hooks/cursor-hook.mjs) | (1) records the turn's activity right away; (2) with an admin key, pulls the exact tokens from the Admin API | `CURSOR_API_KEY` for exact tokens |

> ⚠️ **Why Cursor needs an API key.** Cursor's billed token count **doesn't exist on the machine**:
> the Cursor hook receives no tokens, and the local DB only has context *estimates*. The exact
> number only exists server-side (Admin API, Team/Business plan). The hook automates that pull —
> you still run nothing — but without the admin key you can only see *activity*, not the tokens.

## Setup

```bash
npm install                 # no native build — uses Node's built-in SQLite
npm link                    # puts the ai-usage-* commands on your PATH
cp .env.example .env
```

`npm link` exposes every tool as a **command you can call by name** (`ai-usage-claude-hook`,
`ai-usage-cursor-hook`, `ai-usage-mcp`, `ai-usage-stats`, …), so nothing below hardcodes an
absolute path to this repo. Each command resolves its own location, so it works from any
directory. (Prefer not to link globally? Run them from the repo with `npx ai-usage-<name>`,
or fall back to `node ./hooks/<file>.mjs` with a path.)

There is **no service to start**. The hooks write to the DB directly and the MCP server is
spawned on demand by your client. The DB defaults to `metrics.db` at the repo root; set
`IA_USAGE_DASHBOARD_DB_PATH` only if you keep it elsewhere:

```bash
export IA_USAGE_DASHBOARD_DB_PATH="$HOME/somewhere/metrics.db"   # optional; the commands find the repo DB by default
```

### 1. Enable the Claude Code hook

Register the hook in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "ai-usage-claude-hook" }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "ai-usage-claude-hook" }] }
    ]
  }
}
```

Done — from then on, every Claude Code turn writes the exact usage on its own. The hook is
silent and never blocks Claude Code; if a write ever fails it just retries next turn.

### 2. Enable the Cursor hook

Create `~/.cursor/hooks.json` (or `<project>/.cursor/hooks.json`) — see the example at
[hooks/cursor-hooks.example.json](hooks/cursor-hooks.example.json):

```json
{ "version": 1, "hooks": { "stop": [{ "command": "ai-usage-cursor-hook" }] } }
```

For Cursor's **exact tokens**, also export the admin key
(Cursor Dashboard → Settings → Cursor Admin API Keys):

```bash
export CURSOR_API_KEY=<cursor-admin-key>
```

### 3. Register the read-only MCP (Claude / Cursor)

```bash
claude mcp add ai-usage -- ai-usage-mcp
```

For Cursor, the repo already ships [.cursor/mcp.json](.cursor/mcp.json) (runs `npm run mcp`
from the repo — no path needed).

In the client: *"use the `token_usage` tool (period 30d, group_by model) and make a bar chart"* → artifact/canvas.

## Query tools (MCP)

| Tool | What it returns |
|------|-----------------|
| `by_task` | **AI effort per task/issue** (Jira etc.): tokens, messages, tools, errors, sessions |
| `token_usage` | **sum of exact tokens** (in/out/cache) + cost, by day/model/source/user/project/**task** |
| `latency_stats` | per-turn latency: avg, p50, **p95**, max — by day or model |
| `tool_stats` | most-used tools + **error rate** (errors/use) + web search/fetch |
| `stop_reasons` | distribution of `stop_reason` (`max_tokens` truncations, refusals) |
| `productivity` | **Cursor**: code and tab accept rate, accepted/rejected lines |
| `query_usage` | event counts by day/user/project/tool/source |
| `top_tools` | most-used tools |
| `sessions_summary` | per-session summary with duration |

### Metrics captured per event

- **`message`** (Claude Code and Cursor): exact tokens, `model`, and in `meta`: `stop_reason`,
  `latency_ms` (turn time), `n_tools`, `tools`, `web_search`/`web_fetch`, `gitBranch`.
- **`tool_use`**: one per tool called (feeds `top_tools`/`tool_stats`).
- **`error`**: one per `tool_result` with an error (denominator = `tool_use` → error rate).
- **`productivity`** (Cursor, daily): lines added/accepted, tabs shown/accepted, applies.

## Task (Jira/issue) link per session

Each AI session is linked to a task, to measure **AI effort per issue**. Resolution
happens automatically at the start of the session, in order of precision:

1. **`.dash-task`** — file at the repo root with the ID (explicit override).
2. **Git branch** — a Jira-style ID in the branch name (`feature/PROJ-123-...` → `PROJ-123`).
3. **User prompt** — an ID mentioned, or the explicit marker `#task PROJ-123` (correct it any time).
4. **If none of the above resolves precisely** → the `SessionStart` hook injects context
   instructing Claude to **ask the user for the ID** before starting (best-effort — a
   `SessionStart` hook can't block, so the model may skip the question). Regardless of
   whether it asks, the reply is captured on its own by the `UserPromptSubmit` hook, so the
   guaranteed ways to set the task are `.dash-task`, the branch name, or `#task PROJ-123`.

Hooks involved (registered in `~/.claude/settings.json`):

```json
"SessionStart":    [{ "hooks": [{ "type": "command", "command": "ai-usage-session-task" }] }],
"UserPromptSubmit":[{ "hooks": [{ "type": "command", "command": "ai-usage-task-capture" }] }]
```

The ID pattern is configurable via `DASH_TASK_PATTERN` (regex). The default is Jira-style
(`PROJ-123`). `task_id` becomes a first-class field on every event; query it with
`by_task` or `token_usage group_by=task_id`.

## Slash command `/dash_stats`

Query a task's stats straight from Claude Code:

```
/dash_stats DEMO-100   → stats for the given task
/dash_stats            → uses the ACTIVE task of the current session
```

Returns tokens (in/out/cache), messages, tool calls + error rate,
p50/p95 latency, per-model breakdown and top tools — all for that issue.

Pieces: the `ai-usage-stats` command ([scripts/task-stats.mjs](scripts/task-stats.mjs) —
resolves the task and reads the local SQLite DB directly via `taskStats()` in
[lib/db.mjs](lib/db.mjs)) + the command in `~/.claude/commands/dash_stats.md`. Run it as
`ai-usage-stats DEMO-100` (or `npm run stats -- DEMO-100` from the repo). Point it at a
non-default DB with `IA_USAGE_DASHBOARD_DB_PATH`. The active task is the session's most recent task state.

## History backfill (optional, runs once)

The hooks capture from now on. To import ALL the existing history one single time:

```bash
npm run collect:claude                       # scans ~/.claude/projects/**.jsonl
CURSOR_API_KEY=<key> npm run collect:cursor
```

Both are idempotent (dedup by `ext_id`) — running them again doesn't duplicate.

## Next steps

- Claude Code cost (tokens × per-model price table).
- Fixed dashboards (HTML) beyond the on-demand artifacts.
- Migrate SQLite → Postgres (swap only [lib/db.mjs](lib/db.mjs)).
- Multi-machine collection — if the DB ever needs to live off-box, reintroduce a thin ingest endpoint in front of `insertEvents()` (today it runs single-user on the machine, direct to file).
