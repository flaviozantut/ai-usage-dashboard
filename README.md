# AI Usage Dash

Dashboard de métricas de uso de IA no trabalho, com foco em **tokens exatos** (faturados),
coletados **automaticamente por hooks durante a sessão** — você não roda coletor nenhum.

Três camadas independentes:

1. **Coleta (via hooks)** — hooks de fim de turno enviam o uso exato pra API, sozinhos.
2. **Ingestão + storage** — API Hono recebe em `POST /events`, grava em SQLite (`node:sqlite`, sem dependência nativa).
3. **Consulta/análise** — MCP server de leitura que Claude e Cursor consomem para gerar gráficos (artifacts / canvas).

O contrato do evento ([src/types.ts](src/types.ts)) amarra as três camadas. Tokens são campos de primeira classe.

## Como o token exato chega, automaticamente

Roda **100% local** na sua máquina — a API não tem autenticação; os hooks apenas fazem `POST` no `localhost`.

| Cliente | Hook | O que faz | Precisa de |
|---------|------|-----------|-----------|
| **Claude Code** | `Stop` → [hooks/claude-code-hook.mjs](hooks/claude-code-hook.mjs) | Lê `transcript_path` a cada turno, faz "tail" do transcript e extrai `message.usage` (in/out/cache **exatos**) | nada — 100% local |
| **Cursor** | `stop` → [hooks/cursor-hook.mjs](hooks/cursor-hook.mjs) | (1) registra a atividade do turno na hora; (2) com admin key, puxa os tokens exatos da Admin API | `CURSOR_API_KEY` p/ tokens exatos |

> ⚠️ **Por que o Cursor precisa de API key.** O token faturado do Cursor **não existe na máquina**:
> o hook do Cursor não recebe tokens, e o DB local só tem *estimativas* de contexto. O número
> exato só existe server-side (Admin API, plano Team/Business). O hook automatiza esse pull —
> você continua não rodando nada — mas sem a admin key só dá pra ver *atividade*, não os tokens.

## Setup

```bash
npm install                 # sem build nativo — usa o SQLite embutido do Node
cp .env.example .env
```

### 1. Suba a API

```bash
npm run start:api           # http://localhost:8787  (roda local, sem auth)
```

### 2. Ligue o hook do Claude Code

Opcionalmente, se a API não estiver na porta padrão, aponte o hook pra ela no seu shell (ex. `~/.zshrc`):

```bash
export DASH_API=http://localhost:8787/events
```

Registre o hook no `~/.claude/settings.json` (caminho absoluto):

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

Pronto — a partir daí, todo turno do Claude Code manda o uso exato sozinho. O hook é
silencioso e nunca bloqueia o Claude Code, mesmo com a API fora.

### 3. Ligue o hook do Cursor

Crie `~/.cursor/hooks.json` (ou `<projeto>/.cursor/hooks.json`) — veja o exemplo em
[hooks/cursor-hooks.example.json](hooks/cursor-hooks.example.json):

```json
{ "version": 1, "hooks": { "stop": [{ "command": "node /Users/flaviozantut/Code/AI/dash/hooks/cursor-hook.mjs" }] } }
```

Para os **tokens exatos** do Cursor, exporte também a admin key
(Cursor Dashboard → Settings → Cursor Admin API Keys):

```bash
export CURSOR_API_KEY=<admin-key-do-cursor>
```

### 4. Registre o MCP de leitura (Claude / Cursor)

```bash
claude mcp add ai-usage -- npx tsx /Users/flaviozantut/Code/AI/dash/src/mcp.ts
```

No cliente: *"use a tool `token_usage` (period 30d, group_by model) e faça um gráfico de barras"* → artifact/canvas.

## Tools de consulta (MCP)

| Tool | O que retorna |
|------|---------------|
| `by_task` | **esforço de IA por tarefa/issue** (Jira etc.): tokens, mensagens, ferramentas, erros, sessões |
| `token_usage` | **soma de tokens exatos** (in/out/cache) + custo, por dia/modelo/fonte/usuário/projeto/**tarefa** |
| `latency_stats` | latência por turno: média, p50, **p95**, máx — por dia ou modelo |
| `tool_stats` | ferramentas mais usadas + **taxa de erro** (erros/uso) + web search/fetch |
| `stop_reasons` | distribuição de `stop_reason` (cortes por `max_tokens`, recusas) |
| `productivity` | **Cursor**: accept rate de código e de tabs, linhas aceitas/rejeitadas |
| `query_usage` | contagem de eventos por dia/usuário/projeto/ferramenta/fonte |
| `top_tools` | ferramentas mais usadas |
| `sessions_summary` | resumo por sessão com duração |

### Métricas capturadas por evento

- **`message`** (Claude Code e Curso): tokens exatos, `model`, e em `meta`: `stop_reason`,
  `latency_ms` (tempo do turno), `n_tools`, `tools`, `web_search`/`web_fetch`, `gitBranch`.
- **`tool_use`**: um por ferramenta chamada (alimenta `top_tools`/`tool_stats`).
- **`error`**: um por `tool_result` com erro (denominador = `tool_use` → taxa de erro).
- **`productivity`** (Cursor, diário): linhas add/aceitas, tabs mostradas/aceitas, applies.

## Vínculo com tarefa (Jira/issue) por sessão

Cada sessão de IA é vinculada a uma tarefa, para medir **esforço de IA por issue**. A
resolução acontece automaticamente no início da sessão, por ordem de precisão:

1. **`.dash-task`** — arquivo no raiz do repo com o ID (override explícito).
2. **Branch git** — ID estilo Jira no nome do branch (`feature/PROJ-123-...` → `PROJ-123`).
3. **Prompt do usuário** — ID mencionado, ou marcador explícito `#task PROJ-123` (corrige a qualquer momento).
4. **Se nada acima resolver com precisão** → o hook `SessionStart` injeta contexto e o
   Claude **pergunta o ID ao usuário** antes de começar. A resposta é capturada sozinha.

Hooks envolvidos (registrados no `~/.claude/settings.json`):

```json
"SessionStart":    [{ "hooks": [{ "type": "command", "command": "node /ABS/hooks/session-task.mjs" }] }],
"UserPromptSubmit":[{ "hooks": [{ "type": "command", "command": "node /ABS/hooks/task-capture.mjs" }] }]
```

O padrão de ID é configurável via `DASH_TASK_PATTERN` (regex). O default é estilo Jira
(`PROJ-123`). O `task_id` vira campo de primeira classe em todo evento; consulte com
`by_task` ou `token_usage group_by=task_id`.

## Slash command `/dash_stats`

Consulta as estatísticas de uma tarefa direto no Claude Code:

```
/dash_stats DEMO-100   → estatísticas da tarefa informada
/dash_stats            → usa a tarefa ATIVA da sessão atual
```

Retorna tokens (in/out/cache), mensagens, chamadas de ferramenta + taxa de erro,
latência p50/p95, quebra por modelo e top ferramentas — tudo daquela issue.

Peças: [scripts/task-stats.mjs](scripts/task-stats.mjs) (resolve a tarefa e consulta o
endpoint `GET /stats/task` da API) + o comando em `~/.claude/commands/dash_stats.md`.
A config (URL da API) pode ficar em `~/.claude/dash-state/config.json` — ou usar o default
`http://localhost:8787`. A tarefa ativa é o estado de tarefa mais recente da sessão.

## Backfill do histórico (opcional, roda uma vez)

Os hooks capturam de agora em diante. Para importar TODO o histórico já existente uma única vez:

```bash
npm run collect:claude                       # varre ~/.claude/projects/**.jsonl
CURSOR_API_KEY=<key> npm run collect:cursor
```

Ambos são idempotentes (dedup por `ext_id`) — rodar de novo não duplica.

## Próximos passos

- Custo do Claude Code (tokens × tabela de preço por modelo).
- Dashboards fixos (HTML) além dos artifacts sob demanda.
- Migrar SQLite → Postgres (troque só [src/db.ts](src/db.ts)).
- Auth / multi-tenant — **só** se um dia deixar de ser local (hoje roda single-user na máquina, sem autenticação).
