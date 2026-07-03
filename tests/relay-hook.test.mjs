import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  channelKeys,
  collectKeys,
  seedKeys,
  surface,
  hasInFlightFromAgent,
  buildReason
} from "../lib/relay-hook.mjs";
import { recordOwned } from "../lib/relay-owned.mjs";
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

test("channelKeys: needs_review job dispatched by me surfaces as terminal", () => {
  const keys = channelKeys(j({ id: "a", from: "me", relayState: "needs_review", terminalAtMs: 9 }), "me");
  assert.equal(keys.length, 1);
  assert.equal(keys[0].kind, "terminal");
  assert.equal(keys[0].key, "a:needs_review:9");
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

// --- ownedIds (session-scoped filtering) ---------------------------------

test("channelKeys: ownedIds without the job id excludes a from-side terminal candidate (cross-talk)", () => {
  const owned = new Set(["other-job"]);
  const keys = channelKeys(j({ id: "a", from: "me", relayState: "completed", terminalAtMs: 9 }), "me", owned);
  assert.equal(keys.length, 0);
});

test("channelKeys: ownedIds with the bare job id still surfaces it (not yet delivered)", () => {
  const owned = new Set(["a"]);
  const keys = channelKeys(j({ id: "a", from: "me", relayState: "completed", terminalAtMs: 9 }), "me", owned);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].key, "a:completed:9");
});

test("channelKeys: ownedIds with the id AND the terminal key excludes it (same-session dedup)", () => {
  const owned = new Set(["a", "a:completed:9"]);
  const keys = channelKeys(j({ id: "a", from: "me", relayState: "completed", terminalAtMs: 9 }), "me", owned);
  assert.equal(keys.length, 0);
});

test("channelKeys: inbox events are unaffected by ownedIds (receive side, not dispatch side)", () => {
  const owned = new Set(); // would exclude everything if (wrongly) applied to inbox
  const keys = channelKeys(j({ id: "b", to: "me", relayState: "queued", enqueuedAtMs: 4 }), "me", owned);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].kind, "inbox");
});

test("hasInFlightFromAgent: ownedIds without the job id returns false (cross-talk in long-poll)", () => {
  const owned = new Set(["other-job"]);
  assert.equal(hasInFlightFromAgent([j({ id: "a", from: "me", relayState: "running" })], "me", owned), false);
});

test("hasInFlightFromAgent: ownedIds with the job id returns true", () => {
  const owned = new Set(["a"]);
  assert.equal(hasInFlightFromAgent([j({ id: "a", from: "me", relayState: "running" })], "me", owned), true);
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
  // Blank CLAUDE_CODE_SESSION_ID by default: it's ambient in the real dev session
  // running this test suite, and would otherwise leak in and silently override the
  // per-test `session_id` payload used to key the seen-set/owned-file. Tests that
  // specifically exercise env-vs-payload resolution set it explicitly via `env`.
  const out = execFileSync("node", [HOOK_BIN], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: "", ...env }
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

// --- session isolation (owned-file) ---------------------------------------

test("hook: two sibling sessions under the same RELAY_AGENT — only the dispatching session is notified", () => {
  const { cwd } = setup();
  const env = { RELAY_AGENT: "me" };
  runHook({ hook_event_name: "SessionStart", cwd, session_id: "sibA" }, env);
  runHook({ hook_event_name: "SessionStart", cwd, session_id: "sibB" }, env);

  const e = relay.enqueue(cwd, { requestId: "sib1", from: "me", to: "codex" });
  const c = relay.claim(cwd, e.jobId, "w1");
  relay.complete(cwd, e.jobId, c.claimToken, { ok: true });

  // server.mjs would have recorded this at dispatch time (enqueueFromArgs). Simulate
  // it here: A dispatched this job; B has an owned-file of its own from something
  // unrelated (so its whitelist is non-null and genuinely excludes A's job).
  recordOwned(cwd, "sibA", [e.jobId]);
  recordOwned(cwd, "sibB", ["some-other-job-b-dispatched"]);

  const outB = runHook({ hook_event_name: "Stop", cwd, session_id: "sibB" }, env);
  assert.equal(outB, "", "sibling B never dispatched this job, so it must stay silent");

  const outA = runHook({ hook_event_name: "Stop", cwd, session_id: "sibA" }, env);
  const parsed = JSON.parse(outA);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, new RegExp(`Job ${e.jobId} that you dispatched`));
});

test("hook: no owned-file for this session at all → falls back to today's agentId-only behavior", () => {
  const { cwd } = setup();
  const env = { RELAY_AGENT: "me" };
  runHook({ hook_event_name: "SessionStart", cwd, session_id: "nofile" }, env);

  const e = relay.enqueue(cwd, { requestId: "nofile1", from: "me", to: "codex" });
  const c = relay.claim(cwd, e.jobId, "w1");
  relay.complete(cwd, e.jobId, c.claimToken, { ok: true });

  // No recordOwned() call at all — owned-nofile.json is never created, so the hook
  // must never notify LESS than it did before session-awareness existed.
  const out = runHook({ hook_event_name: "Stop", cwd, session_id: "nofile" }, env);
  const parsed = JSON.parse(out);
  assert.equal(parsed.decision, "block");
});

test("hook: session restart (new session_id) never learns it owns a job dispatched under the old id — accepted limitation", () => {
  const { cwd } = setup();
  const env = { RELAY_AGENT: "me" };
  runHook({ hook_event_name: "SessionStart", cwd, session_id: "old" }, env);

  const e = relay.enqueue(cwd, { requestId: "restart1", from: "me", to: "codex" });
  recordOwned(cwd, "old", [e.jobId]); // dispatched under the OLD session id
  const c = relay.claim(cwd, e.jobId, "w1");
  relay.complete(cwd, e.jobId, c.claimToken, { ok: true });

  // The session restarts under a NEW session id that already has its own owned-file
  // (from dispatching something unrelated), so the whitelist genuinely applies.
  runHook({ hook_event_name: "SessionStart", cwd, session_id: "new" }, env);
  recordOwned(cwd, "new", ["unrelated-new-job"]);

  const out = runHook({ hook_event_name: "Stop", cwd, session_id: "new" }, env);
  assert.equal(out, "", "accepted limitation: the new session id never learns it owns the old job");
});

test("hook: session id mismatch between env and payload is logged to stderr, env wins", () => {
  const { cwd } = setup();
  const env = { RELAY_AGENT: "me", CLAUDE_CODE_SESSION_ID: "env-sess" };
  runHook({ hook_event_name: "SessionStart", cwd, session_id: "payload-sess" }, env);

  const res = spawnSync("node", [HOOK_BIN], {
    input: JSON.stringify({ hook_event_name: "Stop", cwd, session_id: "payload-sess" }),
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
  assert.match(res.stderr, /session id mismatch: env=env-sess payload=payload-sess — using env/);
});
