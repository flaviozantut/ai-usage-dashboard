#!/usr/bin/env node
/**
 * Launcher for the read-only MCP server.
 *
 * Exposed as the `ai-usage-mcp` bin so clients can start it by name (after
 * `npm link` / global install) instead of a hardcoded absolute path — e.g.
 *   claude mcp add ai-usage -- ai-usage-mcp
 *
 * Runs src/mcp.ts in-process through tsx's API (no build step, no subprocess),
 * so the MCP stdio transport uses this process's stdin/stdout directly. Paths are
 * resolved from this file's own location, so it works from any cwd.
 */
import { tsImport } from "tsx/esm/api";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await tsImport(join(root, "src", "mcp.ts"), import.meta.url);
