/**
 * The database lives in `lib/db.mjs` (plain JS) so that the hooks, collectors and
 * scripts — which run under `node`, not `tsx` — can write to it directly, with no
 * server in between. This file just re-exports it with types for the TS side
 * (the MCP server). There is a single SQLite file and a single schema.
 */
export { db, insertEvents, taskStats } from "../lib/db.mjs";
