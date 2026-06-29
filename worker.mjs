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

import fs from "node:fs";
import path from "node:path";

import { drainOnce, runWorkerLoop } from "./lib/relay-worker.mjs";

function parseArgs(argv) {
  const args = {
    agent: "codex",
    once: false,
    allowWrites: false,
    intervalMs: 1000,
    workerId: `cli-${process.pid}`,
    heartbeatFile: null,
    workerToken: null,
    idleTimeoutMs: null
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--agent") args.agent = argv[++i];
    else if (token === "--once") args.once = true;
    else if (token === "--allow-writes") args.allowWrites = true;
    else if (token === "--interval") args.intervalMs = Number(argv[++i]) || args.intervalMs;
    else if (token === "--worker-id") args.workerId = argv[++i];
    else if (token === "--heartbeat-file") args.heartbeatFile = argv[++i];
    else if (token === "--worker-token") args.workerToken = argv[++i];
    else if (token === "--idle-timeout") args.idleTimeoutMs = Number(argv[++i]) || null;
  }
  return args;
}

// Liveness ping for the daemon lifecycle (worker-lifecycle.mjs). Atomic (temp + rename in
// the same dir) so a concurrent reader never sees a half-written heartbeat.
function writeHeartbeat(file, token) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, token, ts: Date.now() }));
  fs.renameSync(tmp, file);
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
  let hbTimer = null;
  const stopHeartbeat = () => {
    if (hbTimer) {
      clearInterval(hbTimer);
      hbTimer = null;
    }
  };
  const shutdown = () => {
    controller.abort();
    stopHeartbeat();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Daemon mode (spawned by worker-lifecycle): emit a heartbeat so the lifecycle can
  // confirm readiness and liveness. Immediate write = fast readiness; then every interval.
  if (args.heartbeatFile && args.workerToken) {
    try {
      writeHeartbeat(args.heartbeatFile, args.workerToken);
    } catch {
      /* best-effort */
    }
    hbTimer = setInterval(() => {
      try {
        writeHeartbeat(args.heartbeatFile, args.workerToken);
      } catch {
        /* best-effort; a missed beat only delays liveness, never loses a job */
      }
    }, args.intervalMs);
    hbTimer.unref?.(); // never keep the process alive on the heartbeat timer alone
  }

  process.stderr.write(`[relay-worker] draining agent=${args.agent} writes=${args.allowWrites} (Ctrl-C to stop)\n`);
  try {
    await runWorkerLoop(cwd, { ...opts, intervalMs: args.intervalMs, idleTimeoutMs: args.idleTimeoutMs, signal: controller.signal });
  } finally {
    stopHeartbeat();
  }
}

main().catch((err) => {
  process.stderr.write(`[relay-worker] ${err?.stack || err}\n`);
  process.exit(1);
});
