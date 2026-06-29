#!/usr/bin/env node
// relay-stop-hook.mjs — Claude Code hook that wakes the session when a relay job
// THIS agent cares about changes state. The pull-side equivalent of the MCP
// channel, with no `--dangerously-load-development-channels` and no dialog.
//
// WIRE IT (settings.json — same command on both events):
//   {
//     "hooks": {
//       "SessionStart": [{ "hooks": [{ "type": "command",
//         "command": "node /ABS/PATH/mcp-agent-relay/bin/relay-stop-hook.mjs" }] }],
//       "Stop":         [{ "hooks": [{ "type": "command",
//         "command": "node /ABS/PATH/mcp-agent-relay/bin/relay-stop-hook.mjs" }] }]
//     }
//   }
//   Requires RELAY_AGENT in the environment (the session identity) — without it
//   the hook is a no-op, exactly like the channel with no agent id.
//
// EVENTS:
//   SessionStart → seed the per-session seen-set with everything already in the
//                  store, so the first Stop does not flood Claude with old jobs.
//   Stop / SubagentStop → surface any NEW terminal/inbox jobs since the seed. If
//                  RELAY_HOOK_WAIT_MS>0 and a dispatched job is still in flight,
//                  long-poll up to that budget for it to finish before deciding.
//
// CONTRACT: stdout carries the hook control JSON ONLY (logs go to stderr). To
//   block the stop we print {"decision":"block","reason":"…"}; to allow it we
//   exit 0 silently. We FAIL OPEN: any internal error → allow the stop, never
//   wedge the session.

import fs from "node:fs";
import path from "node:path";

import { list } from "../lib/relay-jobs.mjs";
import { resolveStateDir } from "../lib/store-paths.mjs";
import { surface, seedKeys, hasInFlightFromAgent, buildReason } from "../lib/relay-hook.mjs";

const AGENT_ID = process.env.RELAY_AGENT || null;
const WAIT_MS = Math.max(0, Number(process.env.RELAY_HOOK_WAIT_MS) || 0);
const POLL_MS = Math.max(250, Number(process.env.RELAY_HOOK_POLL_MS) || 1500);

function log(msg) {
  process.stderr.write(`[relay-hook] ${msg}\n`);
}

// Allow the stop and exit. stdout stays empty so Claude Code treats it as "no
// objection". Always exit 0 — a non-zero hook exit is surfaced to the user as an
// error, which we never want for the benign "nothing to surface" path.
function allow() {
  process.exit(0);
}

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function sanitizeId(id) {
  return String(id || "default").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "default";
}

function seenFile(cwd, sessionId) {
  return path.join(resolveStateDir(cwd), `hook-seen-${sanitizeId(sessionId)}.json`);
}

function loadSeen(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return null; // missing/corrupt → caller decides (seed vs treat-as-empty)
  }
}

function writeSeen(file, seenSet) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify([...seenSet]));
    fs.renameSync(tmp, file);
  } catch (err) {
    log(`could not persist seen-set: ${err.message}`);
  }
}

function readJobs(cwd) {
  try {
    return list(cwd);
  } catch (err) {
    log(`could not read relay store: ${err.message}`);
    return [];
  }
}

function sleep(ms) {
  // Synchronous sleep: hooks are short-lived processes and Claude Code waits for
  // exit, so a blocking wait is simplest and keeps the seen-set logic linear.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function main() {
  if (!AGENT_ID) {
    // No session identity → behave like the channel with no RELAY_AGENT: silent.
    allow();
  }

  let input = {};
  try {
    const raw = readStdin().trim();
    if (raw) input = JSON.parse(raw);
  } catch {
    // Malformed hook payload — fail open.
    allow();
  }

  const event = input.hook_event_name || "Stop";
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const file = seenFile(cwd, input.session_id);

  // SessionStart: seed and exit. Everything already in the store is "old".
  if (event === "SessionStart") {
    writeSeen(file, new Set(seedKeys(readJobs(cwd), AGENT_ID)));
    allow();
  }

  // Stop / SubagentStop: surface new transitions since the seed.
  let seen = loadSeen(file);
  if (seen === null) {
    // No baseline (SessionStart not wired, or first run): seed-and-allow so we
    // never flood Claude with jobs that predate this session. Subsequent stops
    // then surface only genuinely new transitions.
    writeSeen(file, new Set(seedKeys(readJobs(cwd), AGENT_ID)));
    log("no seen-set baseline — seeded and allowing this stop (wire SessionStart for full coverage)");
    allow();
  }

  let jobs = readJobs(cwd);
  let { fresh, nextSeen } = surface(jobs, AGENT_ID, seen);

  // Optional long-poll: if nothing surfaced yet but a dispatched job is still in
  // flight, wait for it (bounded by WAIT_MS) rather than letting the session
  // settle. Skipped when already mid-continuation (stop_hook_active) so repeated
  // stops cannot pin the session indefinitely.
  if (fresh.length === 0 && WAIT_MS > 0 && !input.stop_hook_active) {
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline && hasInFlightFromAgent(jobs, AGENT_ID)) {
      sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
      jobs = readJobs(cwd);
      ({ fresh, nextSeen } = surface(jobs, AGENT_ID, seen));
      if (fresh.length > 0) break;
    }
  }

  if (fresh.length === 0) {
    allow();
  }

  writeSeen(file, nextSeen);
  block(buildReason(fresh));
}

main();
