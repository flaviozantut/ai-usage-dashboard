#!/usr/bin/env node
// Driver de teste: fala o protocolo MCP (stdio JSON-RPC) com src/mcp.ts,
// exatamente como Claude/Cursor fariam, e chama a tool token_usage.
import { spawn } from "node:child_process";

const srv = spawn("npx", ["tsx", "src/mcp.ts"], { stdio: ["pipe", "pipe", "inherit"] });

let buf = "";
const pending = new Map();
srv.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let id = 0;
function req(method, params) {
  return new Promise((resolve) => {
    const _id = ++id;
    pending.set(_id, resolve);
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: _id, method, params }) + "\n");
  });
}
function notify(method, params) {
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const init = await req("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke", version: "1.0" },
});
console.log("1) initialize ->", init.result.serverInfo.name, init.result.serverInfo.version);
notify("notifications/initialized", {});

const tools = await req("tools/list", {});
console.log("2) tools/list ->", tools.result.tools.map((t) => t.name).join(", "));

async function callTool(name, args) {
  const r = await req("tools/call", { name, arguments: args });
  console.log(`\n3) tools/call ${name}(${JSON.stringify(args)}) ->`);
  console.log(r.result.content[0].text.split("\n").slice(0, 14).join("\n"));
}
await callTool("by_task", { period: "all", limit: 10 });
await callTool("token_usage", { period: "all", group_by: "task_id" });

srv.kill();
process.exit(0);
