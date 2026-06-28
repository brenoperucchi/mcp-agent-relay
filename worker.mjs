#!/usr/bin/env node
// relay-worker.mjs — CLI entrypoint that drains the relay's queue for an agent.
//
// ASYNC relay jobs (enqueued via the MCP facade's `dispatch`) only execute while a
// worker is running. Run this to process them:
//
//   node relay-worker.mjs --agent codex            # loop (Ctrl-C to stop)
//   node relay-worker.mjs --agent codex --once     # drain one job and exit
//   node relay-worker.mjs --agent codex --allow-writes   # permit write turns
//
// Writes are denied by default; pass --allow-writes to let write jobs run.

import { drainOnce, runWorkerLoop } from "./lib/relay-worker.mjs";

function parseArgs(argv) {
  const args = {
    agent: "codex",
    once: false,
    allowWrites: false,
    intervalMs: 1000,
    workerId: `cli-${process.pid}`
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--agent") args.agent = argv[++i];
    else if (token === "--once") args.once = true;
    else if (token === "--allow-writes") args.allowWrites = true;
    else if (token === "--interval") args.intervalMs = Number(argv[++i]) || args.intervalMs;
    else if (token === "--worker-id") args.workerId = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const opts = { agentId: args.agent, workerId: args.workerId, allowWrites: args.allowWrites };

  if (args.once) {
    const result = await drainOnce(cwd, opts);
    process.stderr.write(`${JSON.stringify(result ?? { outcome: "idle" })}\n`);
    return;
  }

  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());
  process.stderr.write(`[relay-worker] draining agent=${args.agent} writes=${args.allowWrites} (Ctrl-C to stop)\n`);
  await runWorkerLoop(cwd, { ...opts, intervalMs: args.intervalMs, signal: controller.signal });
}

main().catch((err) => {
  process.stderr.write(`[relay-worker] ${err?.stack || err}\n`);
  process.exit(1);
});
