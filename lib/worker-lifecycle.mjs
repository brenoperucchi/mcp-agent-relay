// worker-lifecycle.mjs — auto-spawn + reuse a worker DAEMON, so jobs execute without
// anyone running `node worker.mjs`. Mirrors broker-lifecycle's reuse-if-alive pattern, but
// the worker serves no requests, so liveness is PID + a token-scoped heartbeat file.
//
// Design (reviewed adversarially — see docs/plans/worker-daemon.md, verdict approve):
//   - The relay file lock (file-lock.mjs) is a SYNCHRONOUS busy-wait; every critical section
//     here is short and synchronous. The async readiness wait happens OUTSIDE any lock.
//   - ensureWorkerSession is single-flight per (cwd,agent) in-process (debounce) AND across
//     processes (per-agent lifecycle lock). A "starting" claim under the lock makes a second
//     caller back off instead of spawning a duplicate.
//   - Liveness `isAliveAndOurs` is a single synchronous read (safe inside the lock). The
//     two-sample heartbeat-advance proof (`provenLiveAndOurs`) — required before SIGTERM-ing a
//     pid taken from state — runs only outside the lock.
//   - Adopt (abandoned starter) and the original starter's timeout cleanup both CAS on
//     (token, status==="starting") under the lock, so "adopt then kill" cannot interleave.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { withFileLock, DEFAULT_LOCK_TIMEOUT_MS } from "./file-lock.mjs";
import { resolveStateDir } from "./store-paths.mjs";

export const DEFAULT_INTERVAL_MS = 1000;
export const DEFAULT_READINESS_TIMEOUT_MS = 5000;
const KILL_GRACE_MS = 2000;
const STALE_SLACK_MS = 5000;

const AGENT_RE = /^[A-Za-z0-9_.-]{1,64}$/;

function safeAgent(agent) {
  if (typeof agent !== "string" || !AGENT_RE.test(agent)) {
    throw new Error(`worker-lifecycle: invalid agent id ${JSON.stringify(agent)}`);
  }
  return agent;
}

function stateFile(cwd, agent) {
  return path.join(resolveStateDir(cwd), `worker-${agent}.json`);
}
function lockFile(cwd, agent) {
  return path.join(resolveStateDir(cwd), `worker-${agent}.lock`);
}
function logFileFor(cwd, agent) {
  return path.join(resolveStateDir(cwd), `worker-${agent}.log`);
}
function heartbeatFile(cwd, agent, token) {
  // Token-scoped: a departing daemon and its replacement never write the same file.
  return path.join(resolveStateDir(cwd), `worker-${agent}-${token}.heartbeat`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logErr(msg) {
  try {
    process.stderr.write(`[worker-lifecycle] ${msg}\n`);
  } catch {
    /* stderr gone */
  }
}

// --- state + heartbeat I/O (atomic writes) -------------------------------

function readState(cwd, agent) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(cwd, agent), "utf8"));
  } catch {
    return null;
  }
}

function writeState(cwd, agent, state) {
  const file = stateFile(cwd, agent);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function unlinkState(cwd, agent) {
  try {
    fs.unlinkSync(stateFile(cwd, agent));
  } catch {
    /* already gone */
  }
}

function readHeartbeat(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function unlinkQuietly(file) {
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

// --- liveness ------------------------------------------------------------

// pid must be a real, signalable process id. Reject 0/1/negative: with a process-GROUP
// kill, `process.kill(-1, …)` would broadcast to every process we can signal and
// `process.kill(-0, …)` targets our own group — a corrupt state file must never reach that.
function isSignalablePid(pid) {
  return Number.isInteger(pid) && pid > 1;
}

function pidAlive(pid) {
  if (!isSignalablePid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // alive but not ours
  }
}

function staleMsFor(intervalMs) {
  return Math.max(3 * (intervalMs || DEFAULT_INTERVAL_MS), DEFAULT_LOCK_TIMEOUT_MS + STALE_SLACK_MS);
}

// Single SYNCHRONOUS read — safe inside the lock. A false "alive" is only ever
// non-destructive (it delays a respawn until the heartbeat goes stale).
function isAliveAndOurs(state, now = Date.now()) {
  if (!state || !Number.isInteger(state.pid) || !state.token || !state.heartbeatFile) {
    return false;
  }
  if (!pidAlive(state.pid)) return false;
  const hb = readHeartbeat(state.heartbeatFile);
  if (!hb || hb.token !== state.token || hb.pid !== state.pid) return false;
  return now - hb.ts < staleMsFor(state.intervalMs);
}

// Stronger proof, required before SIGNALING a pid taken from state: the heartbeat ts must
// ADVANCE across two samples. A dead worker's heartbeat is frozen even if still "fresh", and
// a recycled PID isn't writing our token-scoped file. Runs OUTSIDE any lock (it awaits).
async function provenLiveAndOurs(state) {
  if (!isAliveAndOurs(state)) return false;
  const hb1 = readHeartbeat(state.heartbeatFile);
  if (!hb1) return false;
  await sleep((state.intervalMs || DEFAULT_INTERVAL_MS) + 250);
  const hb2 = readHeartbeat(state.heartbeatFile);
  if (!hb2 || hb2.token !== state.token || hb2.pid !== state.pid) return false;
  return hb2.ts > hb1.ts && pidAlive(state.pid);
}

// --- process control -----------------------------------------------------

// Signal the process GROUP (POSIX `kill(-pid)`) so the worker's codex children die too.
// Never signals an unsafe pid (0/1/negative). On POSIX there is no bare-pid fallback: a
// detached worker IS a group leader, so a failing group kill means it is already gone.
function killGroup(pid, signal) {
  if (!isSignalablePid(pid)) return;
  if (process.platform === "win32") {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    /* group already gone */
  }
}

function onceExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("close", resolve);
    child.once("exit", resolve);
    child.once("error", resolve);
  });
}

function defaultScriptPath() {
  return fileURLToPath(new URL("../worker.mjs", import.meta.url));
}

function spawnWorker(cwd, { agent, allowWrites, intervalMs, token, scriptPath, env }) {
  const hbFile = heartbeatFile(cwd, agent, token);
  const lf = logFileFor(cwd, agent);
  fs.mkdirSync(path.dirname(lf), { recursive: true });
  const cliArgs = [
    scriptPath,
    "--agent", agent,
    "--interval", String(intervalMs),
    "--heartbeat-file", hbFile,
    "--worker-token", token,
    "--worker-id", `daemon-${token}`
  ];
  if (allowWrites) cliArgs.push("--allow-writes");
  const out = fs.openSync(lf, "a");
  let child;
  try {
    child = spawn(process.execPath, cliArgs, {
      cwd,
      env: { ...env, CLAUDE_PROJECT_DIR: cwd },
      detached: true, // own process group + survives the spawner
      stdio: ["ignore", out, out]
    });
  } finally {
    fs.closeSync(out); // always close our FD, even if spawn throws synchronously
  }
  child.unref();
  return { child, hbFile, logFile: lf };
}

async function waitForReady(cwd, agent, token, timeoutMs) {
  const hbFile = heartbeatFile(cwd, agent, token);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hb = readHeartbeat(hbFile);
    if (hb && hb.token === token && Number.isInteger(hb.pid) && pidAlive(hb.pid)) {
      return true;
    }
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
}

// --- the public API ------------------------------------------------------

const inFlight = new Map(); // key -> Promise (per-process single-flight / debounce)

export function ensureWorkerSession(cwd, opts = {}) {
  let agent;
  try {
    agent = safeAgent(opts.agent ?? "codex");
  } catch (err) {
    return Promise.reject(err); // always reject via the promise, never throw synchronously
  }
  const key = `${cwd}::${agent}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const p = _ensure(cwd, { ...opts, agent }).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function _ensure(cwd, opts) {
  const agent = opts.agent;
  const allowWrites = Boolean(opts.allowWrites);
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const scriptPath = opts.scriptPath ?? defaultScriptPath();
  const env = opts.env ?? process.env;
  const lf = lockFile(cwd, agent);
  const startingStaleMs = timeoutMs + KILL_GRACE_MS + STALE_SLACK_MS;

  // Phase 1 — short SYNCHRONOUS critical section under the per-agent lifecycle lock.
  let phase1;
  withFileLock(
    lf,
    () => {
      const state = readState(cwd, agent);
      const now = Date.now();

      if (state && state.status === "running" && isAliveAndOurs(state, now)) {
        phase1 = state.allowWrites === allowWrites ? { kind: "reuse", state } : { kind: "refuse", state };
        return;
      }
      if (state && state.status === "starting" && now - Date.parse(state.startedAt) < startingStaleMs) {
        phase1 = { kind: "starting", state }; // another starter still owns it — back off
        return;
      }
      if (state && state.status === "starting" && isAliveAndOurs(state, now)) {
        // Abandoned but live starter — adopt under the lock (CAS: status is still "starting").
        const adopted = { ...state, status: "running" };
        writeState(cwd, agent, adopted);
        phase1 = { kind: "adopted", state: adopted };
        return;
      }
      // no worker / dead / stale-and-not-live → spawn a fresh one.
      if (state) unlinkQuietly(state.heartbeatFile); // best-effort, no signaling here
      const token = `${process.pid}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
      const spawned = spawnWorker(cwd, { agent, allowWrites, intervalMs, token, scriptPath, env });
      const newState = {
        pid: spawned.child.pid,
        token,
        status: "starting",
        agent,
        allowWrites,
        intervalMs,
        heartbeatFile: spawned.hbFile,
        logFile: spawned.logFile,
        startedAt: new Date(now).toISOString()
      };
      try {
        writeState(cwd, agent, newState);
      } catch (err) {
        // Never leave a running daemon with no durable state / no cleanup path.
        killGroup(spawned.child.pid, "SIGKILL");
        unlinkQuietly(spawned.hbFile);
        throw err;
      }
      phase1 = { kind: "spawned", state: newState, child: spawned.child, token };
    },
    { lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS }
  );

  if (phase1.kind === "reuse" || phase1.kind === "adopted" || phase1.kind === "starting") {
    return phase1.state;
  }
  if (phase1.kind === "refuse") {
    logErr(
      `a worker for "${agent}" is running with allowWrites=${phase1.state.allowWrites}; ` +
        `refusing to (re)spawn with allowWrites=${allowWrites}. Stop it first to change write capability.`
    );
    return phase1.state;
  }

  // Phase 2 — readiness wait OUTSIDE any lock.
  const { child, token } = phase1;
  const ready = await waitForReady(cwd, agent, token, timeoutMs);

  if (ready) {
    let result = null;
    withFileLock(
      lf,
      () => {
        const cur = readState(cwd, agent);
        if (cur && cur.token === token && cur.status === "starting") {
          const running = { ...cur, status: "running" };
          writeState(cwd, agent, running);
          result = running;
        } else {
          result = cur; // adopted/replaced by someone else; relinquish ownership
        }
      },
      { lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS }
    );
    return result;
  }

  // Timeout — decide kill-vs-relinquish UNDER the lock (CAS), THEN act on our own handle.
  let intent = "relinquish";
  withFileLock(
    lf,
    () => {
      const cur = readState(cwd, agent);
      if (cur && cur.token === token && cur.status === "starting") {
        unlinkState(cwd, agent);
        intent = "kill";
      }
    },
    { lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS }
  );

  if (intent === "kill") {
    killGroup(child.pid, "SIGTERM");
    const t = setTimeout(() => killGroup(child.pid, "SIGKILL"), KILL_GRACE_MS);
    t.unref?.();
    await onceExit(child);
    clearTimeout(t);
    unlinkQuietly(heartbeatFile(cwd, agent, token));
  }
  // intent === relinquish: an adopter flipped status to "running"; leave the live worker be.
  return intent === "kill" ? null : readState(cwd, agent);
}

// Explicit stop (used by tests and operators). Only SIGNALS a state pid when its identity is
// proven (advancing heartbeat); otherwise just unlinks the leftover state.
export async function stopWorker(cwd, agentRaw) {
  const agent = safeAgent(agentRaw);
  const state = readState(cwd, agent);
  if (!state) return { stopped: false, reason: "no-state" };

  const proven = await provenLiveAndOurs(state);
  if (proven) {
    killGroup(state.pid, "SIGTERM");
    const t = setTimeout(() => killGroup(state.pid, "SIGKILL"), KILL_GRACE_MS);
    t.unref?.();
    await sleep(KILL_GRACE_MS + 250);
    clearTimeout(t);
  }
  withFileLock(
    lockFile(cwd, agent),
    () => {
      const cur = readState(cwd, agent);
      if (cur && cur.token === state.token) unlinkState(cwd, agent);
    },
    { lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS }
  );
  unlinkQuietly(state.heartbeatFile);
  return { stopped: proven, reason: proven ? "signaled" : "not-proven-unlinked" };
}

// Exposed for tests.
export const __internals = {
  stateFile,
  lockFile,
  heartbeatFile,
  readState,
  writeState,
  isAliveAndOurs,
  provenLiveAndOurs,
  staleMsFor
};
