#!/usr/bin/env node
// Fork-only guard. The monorepo root carries a `bin` entry and a mirrored copy of the MCP
// server's runtime dependencies so that `npx -y github:ivaneecreator-web/kie-ai-mcp-server`
// works: a git install resolves the root package's dependencies only, never the workspaces'.
// That mirror silently rots whenever upstream adds, drops, or bumps an MCP dependency, and
// the failure lands on a buyer as a module-not-found crash at launch. Fail the sync instead.
// See docs/FORK-NOTES.md.
import { readFileSync, statSync } from "node:fs";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const root = read("../package.json");
const mcp = read("../packages/mcp/package.json");
const problems = [];

const BIN = "packages/mcp/dist/index.js";
if (root.bin?.["kie-ai-mcp-server"] !== BIN) {
  problems.push(`root package.json bin["kie-ai-mcp-server"] must be "${BIN}"`);
}

const rootDeps = root.dependencies ?? {};
const mcpDeps = mcp.dependencies ?? {};
for (const [name, range] of Object.entries(mcpDeps)) {
  if (!(name in rootDeps)) problems.push(`root dependencies is missing "${name}": "${range}"`);
  else if (rootDeps[name] !== range)
    problems.push(`root "${name}" is "${rootDeps[name]}" but packages/mcp wants "${range}"`);
}
for (const name of Object.keys(rootDeps)) {
  if (!(name in mcpDeps)) problems.push(`root dependency "${name}" is not an MCP dependency`);
}

try {
  const mode = statSync(new URL(`../${BIN}`, import.meta.url)).mode & 0o111;
  if (!mode) problems.push(`${BIN} is not executable; run "npm run fork:bundle"`);
} catch {
  problems.push(`${BIN} is missing; run "npm run fork:bundle"`);
}

if (problems.length) {
  console.error("Fork npx shim is broken:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  console.error("\nSee docs/FORK-NOTES.md. Buyers install this repo straight from git.");
  process.exit(1);
}
console.log("Fork npx shim OK: bin entry, mirrored runtime deps, executable bundle.");
