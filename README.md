# AI Usage Dash

Dashboard of AI usage metrics at work, focused on **exact (billed) tokens**,
collected **automatically by hooks during the session** — you don't run any collector.

Three independent layers:

1. **Collection (via hooks)** — end-of-turn hooks send the exact usage to the API on their own.
2. **Ingestion + storage** — a Hono API receives at `POST /events` and writes to SQLite (`node:sqlite`, no native dependency).
3. **Query/analysis** — a read-only MCP server that Claude and Cursor consume to generate charts (artifacts / canvas).

The event contract ([src/types.ts](src/types.ts)) ties the three layers together. Tokens are first-class fields.

## How the exact token arrives, automatically

Runs **100% local** on your machine — the API has no authentication; the hooks just `POST` to `localhost`.

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
cp .env.example .env
```

### 1. Start the API

```bash
npm run start:api           # http://localhost:8787  (runs locally, no auth)
```

### 2. Enable the Claude Code hook

Optionally, if the API isn't on the default port, point the hook at it in your shell (e.g. `~/.zshrc`):

```bash
export DASH_API=http://localhost:8787/events
```

Register the hook in `~/.claude/settings.json` (absolute path):

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node /Users/flaviozantut/Code/AI/dash/hooks/claude-code-hook.mjs" }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "node /Users/flaviozantut/Code/AI/dash/hooks/claude-code-hook.mjs" }] }
    ]
  }
}
```

Done — from then on, every Claude Code turn sends the exact usage on its own. The hook is
silent and never blocks Claude Code, even when the API is down.

### 3. Enable the Cursor hook

Create `~/.cursor/hooks.json` (or `<project>/.cursor/hooks.json`) — see the example at
[hooks/cursor-hooks.example.json](hooks/cursor-hooks.example.json):

```json
{ "version": 1, "hooks": { "stop": [{ "command": "node /Users/flaviozantut/Code/AI/dash/hooks/cursor-hook.mjs" }] } }
```

For Cursor's **exact tokens**, also export the admin key
(Cursor Dashboard → Settings → Cursor Admin API Keys):

```bash
export CURSOR_API_KEY=<cursor-admin-key>
```

### 4. Register the read-only MCP (Claude / Cursor)

```bash
claude mcp add ai-usage -- npx tsx /Users/flaviozantut/Code/AI/dash/src/mcp.ts
```

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
4. **If none of the above resolves precisely** → the `SessionStart` hook injects context and
   Claude **asks the user for the ID** before starting. The reply is captured on its own.

Hooks involved (registered in `~/.claude/settings.json`):

```json
"SessionStart":    [{ "hooks": [{ "type": "command", "command": "node /ABS/hooks/session-task.mjs" }] }],
"UserPromptSubmit":[{ "hooks": [{ "type": "command", "command": "node /ABS/hooks/task-capture.mjs" }] }]
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

Pieces: [scripts/task-stats.mjs](scripts/task-stats.mjs) (resolves the task and queries the
API's `GET /stats/task` endpoint) + the command in `~/.claude/commands/dash_stats.md`.
Config (the API URL) can live in `~/.claude/dash-state/config.json` — or use the default
`http://localhost:8787`. The active task is the session's most recent task state.

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
- Migrate SQLite → Postgres (swap only [src/db.ts](src/db.ts)).
- Auth / multi-tenant — **only** if it ever stops being local (today it runs single-user on the machine, no auth).
