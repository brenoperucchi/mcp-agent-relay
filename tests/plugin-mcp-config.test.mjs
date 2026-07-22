import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { executorIds } from "../lib/executor-registry.mjs";

const MCP_CONFIG = fileURLToPath(new URL("../.mcp.json", import.meta.url));

test("plugin MCP config autospawns every allowlisted executor", () => {
  const config = JSON.parse(fs.readFileSync(MCP_CONFIG, "utf8"));
  const env = config.mcpServers.agentrelay.env;

  assert.equal(env.RELAY_WORKER_AUTOSPAWN, "1");
  assert.equal(env.RELAY_WORKER_AGENTS, executorIds().join(","));
});
