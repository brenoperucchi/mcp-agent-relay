import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  channelKeys,
  collectKeys,
  seedKeys,
  surface,
  hasInFlightFromAgent,
  buildReason
} from "../lib/relay-hook.mjs";
import * as relay from "../lib/relay-jobs.mjs";
import { resolveStateDir } from "../lib/store-paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK_BIN = path.join(HERE, "..", "bin", "relay-stop-hook.mjs");
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "relay-hook-cwd-"));

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-hook-data-"));
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  return { cwd: CWD };
}

const j = (o) => ({
  id: "relay-x",
  from: null,
  to: null,
  relayState: "queued",
  enqueuedAtMs: 1,
  terminalAtMs: null,
  ...o
});

// --- pure logic ----------------------------------------------------------

test("channelKeys: terminal job dispatched by me surfaces", () => {
  const keys = channelKeys(j({ id: "a", from: "me", relayState: "completed", terminalAtMs: 9 }), "me");
  assert.equal(keys.length, 1);
  assert.equal(keys[0].kind, "terminal");
  assert.equal(keys[0].key, "a:completed:9");
});

test("channelKeys: terminal job dispatched by someone else is ignored", () => {
  const keys = channelKeys(j({ from: "other", relayState: "completed", terminalAtMs: 9 }), "me");
  assert.equal(keys.length, 0);
});

test("channelKeys: queued job addressed to me surfaces as inbox", () => {
  const keys = channelKeys(j({ id: "b", to: "me", relayState: "queued", enqueuedAtMs: 4 }), "me");
  assert.equal(keys.length, 1);
  assert.equal(keys[0].kind, "inbox");
  assert.equal(keys[0].key, "b:queued:4");
});

test("channelKeys: running job is not an event", () => {
  assert.equal(channelKeys(j({ from: "me", relayState: "running" }), "me").length, 0);
});

test("surface: only NEW keys are returned and seen advances", () => {
  const jobs = [j({ id: "a", from: "me", relayState: "completed", terminalAtMs: 9 })];
  const first = surface(jobs, "me", []);
  assert.equal(first.fresh.length, 1);
  assert.ok(first.nextSeen.has("a:completed:9"));

  const second = surface(jobs, "me", first.nextSeen);
  assert.equal(second.fresh.length, 0, "same transition never surfaces twice");
});

test("surface: a new transition on a seen job surfaces again", () => {
  const seen = new Set(["a:running:0"]); // a different (older) key
  const jobs = [j({ id: "a", from: "me", relayState: "failed", terminalAtMs: 12 })];
  const { fresh } = surface(jobs, "me", seen);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].key, "a:failed:12");
});

test("seedKeys returns every current key as strings", () => {
  const jobs = [
    j({ id: "a", from: "me", relayState: "completed", terminalAtMs: 9 }),
    j({ id: "b", to: "me", relayState: "queued", enqueuedAtMs: 4 })
  ];
  assert.deepEqual(seedKeys(jobs, "me").sort(), ["a:completed:9", "b:queued:4"]);
});

test("hasInFlightFromAgent: true only for my non-terminal dispatches", () => {
  assert.equal(hasInFlightFromAgent([j({ from: "me", relayState: "running" })], "me"), true);
  assert.equal(hasInFlightFromAgent([j({ from: "me", relayState: "completed", terminalAtMs: 1 })], "me"), false);
  assert.equal(hasInFlightFromAgent([j({ from: "other", relayState: "running" })], "me"), false);
});

test("collectKeys spans the whole list", () => {
  const jobs = [
    j({ id: "a", from: "me", relayState: "completed", terminalAtMs: 9 }),
    j({ id: "c", from: "other", relayState: "completed", terminalAtMs: 9 })
  ];
  assert.equal(collectKeys(jobs, "me").length, 1);
});

test("buildReason is notification-only and lists each job", () => {
  const reason = buildReason([
    { kind: "terminal", job: { id: "a", to: "codex", relayState: "completed" } },
    { kind: "inbox", job: { id: "b", from: "peer" } }
  ]);
  assert.match(reason, /Job a that you dispatched to "codex" is now completed/);
  assert.match(reason, /New job b from "peer" is queued/);
  assert.match(reason, /notification only/i);
  assert.match(reason, /do NOT follow/);
});

// --- executable hook (stdin/stdout contract) -----------------------------

function runHook(input, env = {}) {
  const out = execFileSync("node", [HOOK_BIN], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
  return out.trim();
}

test("hook: no RELAY_AGENT → silent allow (empty stdout)", () => {
  const { cwd } = setup();
  const out = runHook({ hook_event_name: "Stop", cwd, session_id: "s1" }, { RELAY_AGENT: "" });
  assert.equal(out, "");
});

test("hook: SessionStart seeds, then Stop allows when nothing new", () => {
  const { cwd } = setup();
  // A job completed BEFORE the session starts must not wake the first Stop.
  const e = relay.enqueue(cwd, { requestId: "r1", from: "me", to: "codex" });
  const c = relay.claim(cwd, e.jobId, "w1");
  relay.complete(cwd, e.jobId, c.claimToken, { ok: true });

  const env = { RELAY_AGENT: "me" };
  assert.equal(runHook({ hook_event_name: "SessionStart", cwd, session_id: "s2" }, env), "");
  assert.equal(runHook({ hook_event_name: "Stop", cwd, session_id: "s2" }, env), "");
});

test("hook: Stop blocks when a dispatched job completed after the seed", () => {
  const { cwd } = setup();
  const env = { RELAY_AGENT: "me" };
  // Seed with an empty store.
  runHook({ hook_event_name: "SessionStart", cwd, session_id: "s3" }, env);

  // Now dispatch + complete a job during the "session".
  const e = relay.enqueue(cwd, { requestId: "r2", from: "me", to: "codex" });
  const c = relay.claim(cwd, e.jobId, "w1");
  relay.complete(cwd, e.jobId, c.claimToken, { ok: true });

  const out = runHook({ hook_event_name: "Stop", cwd, session_id: "s3" }, env);
  const parsed = JSON.parse(out);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, new RegExp(`Job ${e.jobId} that you dispatched`));

  // Second Stop must NOT re-surface the same transition.
  assert.equal(runHook({ hook_event_name: "Stop", cwd, session_id: "s3" }, env), "");
});

test("hook: Stop with no prior baseline seeds-and-allows (no flood)", () => {
  const { cwd } = setup();
  const e = relay.enqueue(cwd, { requestId: "r3", from: "me", to: "codex" });
  const c = relay.claim(cwd, e.jobId, "w1");
  relay.complete(cwd, e.jobId, c.claimToken, { ok: true });

  // No SessionStart for this session id → first Stop seeds rather than flooding.
  const out = runHook({ hook_event_name: "Stop", cwd, session_id: "s4" }, { RELAY_AGENT: "me" });
  assert.equal(out, "");
});

test("hook: seen-set is persisted per session id", () => {
  const { cwd } = setup();
  runHook({ hook_event_name: "SessionStart", cwd, session_id: "persist/me" }, { RELAY_AGENT: "me" });
  const f = path.join(resolveStateDir(cwd), "hook-seen-persist-me.json");
  assert.ok(fs.existsSync(f), "seen-set file written with sanitized name");
});
