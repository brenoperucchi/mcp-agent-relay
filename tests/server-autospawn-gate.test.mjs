import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { resolveStateDir } from "../lib/store-paths.mjs";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));

function makeEnv(extra = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "relay-gate-"));
  return {
    CLAUDE_PLUGIN_DATA: path.join(base, "data"),
    CLAUDE_PROJECT_DIR: path.join(base, "workspace"),
    ...extra
  };
}

function stateDirFor(env) {
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = env.CLAUDE_PLUGIN_DATA;
  try {
    return resolveStateDir(env.CLAUDE_PROJECT_DIR);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
  }
}

function workerStateFiles(env) {
  const dir = stateDirFor(env);
  try {
    return fs.readdirSync(dir).filter((f) => /^worker-.*\.json$/.test(f));
  } catch {
    return [];
  }
}

function startServer(env) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line));
      } catch {
        /* ignore */
      }
    }
  });
  let idSeq = 0;
  return {
    child,
    send: (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`),
    request(method, params) {
      const id = ++idSeq;
      this.send({ jsonrpc: "2.0", id, method, params });
      return new Promise((resolve) => {
        const tick = setInterval(() => {
          const m = messages.find((x) => x.id === id);
          if (m) {
            clearInterval(tick);
            resolve(m);
          }
        }, 10);
        tick.unref?.();
      });
    },
    stop() {
      try { child.stdin.end(); } catch {}
      try { child.kill(); } catch {}
    }
  };
}

async function initAndDispatch(server, to, request_id) {
  await server.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  // payload WITHOUT a `prompt`: a real worker fails it immediately, so no codex is ever run.
  await server.request("tools/call", { name: "dispatch", arguments: { to, task: { note: "no prompt" }, request_id } });
}

function killStateWorkers(env) {
  for (const f of workerStateFiles(env)) {
    try {
      const st = JSON.parse(fs.readFileSync(path.join(stateDirFor(env), f), "utf8"));
      if (Number.isInteger(st.pid)) {
        try { process.kill(-st.pid, "SIGKILL"); } catch {}
        try { process.kill(st.pid, "SIGKILL"); } catch {}
      }
    } catch {
      /* ignore */
    }
  }
}

test("autospawn OFF (default): dispatch spawns no worker daemon", async () => {
  const env = makeEnv(); // RELAY_WORKER_AUTOSPAWN unset
  const server = startServer(env);
  try {
    await initAndDispatch(server, "codex", "g1");
    await delay(1500);
    assert.deepEqual(workerStateFiles(env), [], "no worker-*.json should be created");
  } finally {
    server.stop();
    killStateWorkers(env);
  }
});

test("autospawn ON but target not allow-listed: no worker daemon", async () => {
  const env = makeEnv({ RELAY_WORKER_AUTOSPAWN: "1", RELAY_WORKER_AGENTS: "codex" });
  const server = startServer(env);
  try {
    await initAndDispatch(server, "claude", "g2"); // "claude" is a logical agent, not a worker
    await delay(1500);
    assert.deepEqual(workerStateFiles(env), [], "dispatch to a non-worker agent must not spawn");
  } finally {
    server.stop();
    killStateWorkers(env);
  }
});

test("autospawn ON for an allow-listed agent: a worker daemon appears", async () => {
  const env = makeEnv({ RELAY_WORKER_AUTOSPAWN: "1", RELAY_WORKER_AGENTS: "codex" });
  const server = startServer(env);
  try {
    await initAndDispatch(server, "codex", "g3");
    let files = [];
    for (let i = 0; i < 80; i++) {
      files = workerStateFiles(env);
      if (files.length) break;
      await delay(100);
    }
    assert.deepEqual(files, ["worker-codex.json"], "an allow-listed dispatch spawns one worker daemon");
  } finally {
    server.stop();
    killStateWorkers(env);
  }
});
