import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { enqueue, claim, getJob } from "../lib/relay-jobs.mjs";
import { dispatchAndWait, processJob } from "../lib/relay-worker.mjs";

function cwd() { return fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-worker-")); }

test("Claude worker rejects write jobs before invoking a turn", async () => {
  const dir = cwd();
  const e = enqueue(dir, { requestId: "claude-write", to: "claude-opus", payload: { prompt: "x", write: true } });
  const c = claim(dir, e.jobId, "w", 10_000);
  let called = false;
  const out = await processJob(dir, c.job, c.claimToken, {
    agentId: "claude-opus",
    allowWrites: true,
    runTurn: async () => { called = true; return { ok: true, output: "bad", touchedFiles: [] }; }
  });
  assert.equal(out.outcome, "failed");
  assert.equal(called, false);
  assert.match(getJob(dir, e.jobId).errorMessage, /Claude.*escrita/i);
});

test("dispatchAndWait also preserves the Claude write denial", async () => {
  const dir = cwd();
  let called = false;
  const out = await dispatchAndWait(dir, {
    requestId: "claude-inline-write",
    to: "claude-fable",
    task: { prompt: "x", write: true },
    allowWrites: true,
    runTurn: async () => { called = true; return { ok: true, output: "bad", touchedFiles: [] }; }
  });
  assert.equal(out.state, "failed");
  assert.equal(called, false);
  assert.match(out.error, /Claude.*escrita/i);
});
