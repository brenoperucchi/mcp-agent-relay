import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { ensureWorkerSession, stopWorker, __internals } from "../lib/worker-lifecycle.mjs";

const FAKE_WORKER = fileURLToPath(new URL("./fixtures/fake-worker.mjs", import.meta.url));
const ENSURE_ONCE = fileURLToPath(new URL("./fixtures/ensure-once.mjs", import.meta.url));
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "wl-cwd-"));

const toKill = new Set();
function track(pid) {
  if (Number.isInteger(pid)) toKill.add(pid);
  return pid;
}
function hardKill(pid) {
  try { process.kill(-pid, "SIGKILL"); } catch {}
  try { process.kill(pid, "SIGKILL"); } catch {}
}
afterEach(() => {
  for (const pid of toKill) hardKill(pid);
  toKill.clear();
});

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-data-"));
  process.env.RELAY_DATA_DIR = dataDir;
  return { cwd: CWD, dataDir };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

async function waitFor(fn, { timeout = 4000, step = 25 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await delay(step);
  }
}

function stateFor(overrides) {
  return {
    status: "running",
    agent: "codex",
    allowWrites: false,
    intervalMs: 200,
    logFile: "x",
    startedAt: new Date().toISOString(),
    ...overrides
  };
}

test("ensure spawns a daemon and marks it running", async () => {
  const { cwd } = setup();
  const st = await ensureWorkerSession(cwd, { agent: "codex", scriptPath: FAKE_WORKER, intervalMs: 200, timeoutMs: 4000 });
  track(st.pid);
  assert.equal(st.status, "running");
  assert.ok(pidAlive(st.pid));
  const hb = JSON.parse(fs.readFileSync(st.heartbeatFile, "utf8"));
  assert.equal(hb.token, st.token);
  assert.equal(hb.pid, st.pid);
  await stopWorker(cwd, "codex");
});

test("ensure reuses a live daemon (no second spawn)", async () => {
  const { cwd } = setup();
  const a = await ensureWorkerSession(cwd, { agent: "codex", scriptPath: FAKE_WORKER, intervalMs: 200 });
  track(a.pid);
  const b = await ensureWorkerSession(cwd, { agent: "codex", scriptPath: FAKE_WORKER, intervalMs: 200 });
  assert.equal(b.pid, a.pid);
  assert.equal(b.token, a.token);
  await stopWorker(cwd, "codex");
});

test("ensure refuses to reuse with a different write capability", async () => {
  const { cwd } = setup();
  const ro = await ensureWorkerSession(cwd, { agent: "codex", scriptPath: FAKE_WORKER, allowWrites: false, intervalMs: 200 });
  track(ro.pid);
  const rw = await ensureWorkerSession(cwd, { agent: "codex", scriptPath: FAKE_WORKER, allowWrites: true, intervalMs: 200 });
  assert.equal(rw.pid, ro.pid); // refused -> same daemon, no second spawn
  assert.equal(rw.allowWrites, false);
  await stopWorker(cwd, "codex");
});

test("a stale heartbeat (alive pid) is treated as dead -> respawn", async () => {
  const { cwd } = setup();
  const sleeper = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  track(sleeper.pid);
  const token = "stale-T1";
  const hbFile = __internals.heartbeatFile(cwd, "codex", token);
  fs.mkdirSync(path.dirname(hbFile), { recursive: true });
  fs.writeFileSync(hbFile, JSON.stringify({ pid: sleeper.pid, token, ts: Date.now() - 60000 }));
  __internals.writeState(cwd, "codex", stateFor({ pid: sleeper.pid, token, heartbeatFile: hbFile, startedAt: new Date(Date.now() - 60000).toISOString() }));
  const st = await ensureWorkerSession(cwd, { agent: "codex", scriptPath: FAKE_WORKER, intervalMs: 200 });
  track(st.pid);
  assert.notEqual(st.token, token);
  assert.notEqual(st.pid, sleeper.pid);
  await stopWorker(cwd, "codex");
});

test("stopWorker does not signal a non-advancing (recycled-PID) heartbeat", async () => {
  const { cwd } = setup();
  const stranger = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  track(stranger.pid);
  const token = "frozen-T";
  const hbFile = __internals.heartbeatFile(cwd, "codex", token);
  fs.mkdirSync(path.dirname(hbFile), { recursive: true });
  fs.writeFileSync(hbFile, JSON.stringify({ pid: stranger.pid, token, ts: Date.now() })); // fresh but FROZEN
  __internals.writeState(cwd, "codex", stateFor({ pid: stranger.pid, token, heartbeatFile: hbFile }));
  const res = await stopWorker(cwd, "codex");
  assert.equal(res.stopped, false);
  assert.ok(pidAlive(stranger.pid), "the unrelated process must NOT be killed");
  assert.equal(__internals.readState(cwd, "codex"), null);
});

test("readiness timeout kills the spawned child and persists no state", async () => {
  const { cwd } = setup();
  const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wl-pf-")), "pid");
  const st = await ensureWorkerSession(cwd, {
    agent: "codex",
    scriptPath: FAKE_WORKER,
    intervalMs: 200,
    timeoutMs: 500,
    env: { ...process.env, RELAY_FAKE_SILENT: "1", RELAY_FAKE_PIDFILE: pidFile }
  });
  assert.equal(st, null);
  assert.equal(__internals.readState(cwd, "codex"), null);
  const childPid = Number(fs.readFileSync(pidFile, "utf8"));
  track(childPid);
  const dead = await waitFor(() => !pidAlive(childPid), { timeout: 4000 });
  assert.ok(dead, "the silent child must be killed on readiness timeout");
});

test("two concurrent ensures (separate processes) converge on one daemon", async () => {
  const { cwd, dataDir } = setup();
  const cfg = JSON.stringify({ cwd, agent: "codex", scriptPath: FAKE_WORKER, dataDir, timeoutMs: 4000 });
  const run = () =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, [ENSURE_ONCE, cfg], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.on("close", () => resolve(JSON.parse(out || "{}")));
    });
  const [a, b] = await Promise.all([run(), run()]);
  for (const r of [a, b]) if (r.pid) track(r.pid);
  const tokens = new Set([a.token, b.token].filter(Boolean));
  assert.equal(tokens.size, 1, "exactly one daemon token across both processes");
  const stateDir = path.dirname(__internals.stateFile(cwd, "codex"));
  const hbs = fs.readdirSync(stateDir).filter((f) => f.startsWith("worker-codex-") && f.endsWith(".heartbeat"));
  assert.equal(hbs.length, 1, "exactly one heartbeat file");
  await stopWorker(cwd, "codex");
});

test("heartbeat writes are atomic (no partial reads under load)", async () => {
  const { cwd } = setup();
  const st = await ensureWorkerSession(cwd, { agent: "codex", scriptPath: FAKE_WORKER, intervalMs: 5 });
  track(st.pid);
  let bad = 0;
  for (let i = 0; i < 300; i++) {
    try {
      JSON.parse(fs.readFileSync(st.heartbeatFile, "utf8"));
    } catch {
      bad++;
    }
    await delay(2);
  }
  assert.equal(bad, 0);
  await stopWorker(cwd, "codex");
});

test("an abandoned-but-live starter is adopted (no second spawn)", async () => {
  const { cwd } = setup();
  const token = "adopt-T";
  const hbFile = __internals.heartbeatFile(cwd, "codex", token);
  fs.mkdirSync(path.dirname(hbFile), { recursive: true });
  const w = spawn(process.execPath, [FAKE_WORKER, "--heartbeat-file", hbFile, "--worker-token", token, "--interval", "150"], {
    detached: true,
    stdio: "ignore"
  });
  track(w.pid);
  await waitFor(() => fs.existsSync(hbFile));
  __internals.writeState(cwd, "codex", stateFor({ pid: w.pid, token, status: "starting", intervalMs: 150, heartbeatFile: hbFile, startedAt: new Date(Date.now() - 60000).toISOString() }));
  const st = await ensureWorkerSession(cwd, { agent: "codex", scriptPath: FAKE_WORKER, intervalMs: 150, timeoutMs: 1000 });
  assert.equal(st.token, token, "adopted the existing worker");
  assert.equal(st.status, "running");
  assert.equal(st.pid, w.pid);
  await stopWorker(cwd, "codex");
});

test("an abandoned starter with a dead pid respawns", async () => {
  const { cwd } = setup();
  const token = "dead-T";
  const hbFile = __internals.heartbeatFile(cwd, "codex", token);
  fs.mkdirSync(path.dirname(hbFile), { recursive: true });
  __internals.writeState(cwd, "codex", stateFor({ pid: 2 ** 31 - 1, token, status: "starting", heartbeatFile: hbFile, startedAt: new Date(Date.now() - 60000).toISOString() }));
  const st = await ensureWorkerSession(cwd, { agent: "codex", scriptPath: FAKE_WORKER, intervalMs: 200 });
  track(st.pid);
  assert.notEqual(st.token, token);
  await stopWorker(cwd, "codex");
});

test("invalid agent ids are rejected before any file path is built", async () => {
  const { cwd } = setup();
  await assert.rejects(() => ensureWorkerSession(cwd, { agent: "../evil", scriptPath: FAKE_WORKER }));
  await assert.rejects(() => ensureWorkerSession(cwd, { agent: "a/b", scriptPath: FAKE_WORKER }));
});
