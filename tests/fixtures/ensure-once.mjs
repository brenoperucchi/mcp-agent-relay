#!/usr/bin/env node
// Calls ensureWorkerSession once and prints {pid,token,status} as JSON. Used to exercise the
// CROSS-PROCESS lifecycle lock (two of these racing must converge on one daemon).
import { ensureWorkerSession } from "../../lib/worker-lifecycle.mjs";

const cfg = JSON.parse(process.argv[2]);
if (cfg.dataDir) process.env.RELAY_DATA_DIR = cfg.dataDir;
const res = await ensureWorkerSession(cfg.cwd, {
  agent: cfg.agent,
  scriptPath: cfg.scriptPath,
  timeoutMs: cfg.timeoutMs ?? 4000,
  env: { ...process.env, ...(cfg.fakeEnv || {}) }
});
process.stdout.write(JSON.stringify({ pid: res?.pid ?? null, token: res?.token ?? null, status: res?.status ?? null }));
