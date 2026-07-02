import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import * as relay from "../lib/relay-jobs.mjs";
import * as worker from "../lib/relay-worker.mjs";
import { withWorktreeIsolation } from "../lib/worktree-runner.mjs";

// Separate from tests/relay-worker.test.mjs on purpose: that file's CWD is a
// plain (non-git) tmpdir, which withWorktreeIsolation cannot run against.

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-worker-wt-repo-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "init\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function setup() {
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "relay-worker-wt-data-"));
  return initRepo();
}

// Abort-aware fake turn: writes a file synchronously (simulating a partial
// edit already on disk), then resolves after delayMs unless aborted first.
function abortableWriteTurn(fileName, delayMs) {
  return (cwd, opts) =>
    new Promise((resolve, reject) => {
      fs.writeFileSync(path.join(cwd, fileName), "partial\n");
      const timer = setTimeout(
        () => resolve({ ok: true, output: "done", threadId: null, touchedFiles: [fileName] }),
        delayMs
      );
      const signal = opts?.signal;
      if (signal) {
        const onAbort = () => {
          clearTimeout(timer);
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
}

test("write:true, worktree:true isola a escrita — arquivo existe na worktree, não no cwd principal", async () => {
  const cwd = setup();
  const runInner = async (wtCwd) => {
    fs.writeFileSync(path.join(wtCwd, "isolated.txt"), "hi\n");
    return { ok: true, output: "done", threadId: null, touchedFiles: ["isolated.txt"] };
  };
  const e = relay.enqueue(cwd, { requestId: "iso-1", to: "codex", payload: { prompt: "p", write: true, worktree: true } });
  const c = relay.claim(cwd, e.jobId, "w1", 5000);
  const r = await worker.processJob(cwd, c.job, c.claimToken, { runTurn: withWorktreeIsolation(runInner), allowWrites: true });
  assert.equal(r.outcome, "completed");
  const job = relay.getJob(cwd, e.jobId);
  assert.ok(job.result.worktree);
  assert.ok(fs.existsSync(path.join(job.result.worktree.path, "isolated.txt")));
  assert.equal(fs.existsSync(path.join(cwd, "isolated.txt")), false);
});

test("write:true, worktree:true sem mudanças: job completa sem result.worktree, dir removido", async () => {
  const cwd = setup();
  const runInner = async () => ({ ok: true, output: "done", threadId: null, touchedFiles: [] });
  const e = relay.enqueue(cwd, { requestId: "iso-2", to: "codex", payload: { prompt: "p", write: true, worktree: true } });
  const c = relay.claim(cwd, e.jobId, "w1", 5000);
  const r = await worker.processJob(cwd, c.job, c.claimToken, { runTurn: withWorktreeIsolation(runInner), allowWrites: true });
  assert.equal(r.outcome, "completed");
  const job = relay.getJob(cwd, e.jobId);
  assert.equal(job.result.worktree, undefined);
});

test("timeout/abort com escrita parcial: job vira needs_recovery e a mensagem cita o path da worktree preservada", async () => {
  const cwd = setup();
  const r = await worker.dispatchAndWait(cwd, {
    requestId: "iso-3",
    to: "codex",
    task: { prompt: "slow", write: true, worktree: true },
    runTurn: withWorktreeIsolation(abortableWriteTurn("partial.txt", 500)),
    timeoutMs: 100,
    leaseMs: 2000,
    heartbeatMs: 1000,
    allowWrites: true
  });
  assert.equal(r.timedOut, true);
  const job = relay.getJob(cwd, r.jobId);
  assert.equal(job.relayState, "needs_recovery");
  assert.match(job.errorMessage, /worktree preservada/);
  const pathMatch = job.errorMessage.match(/path=(\S+)/);
  assert.ok(pathMatch, "mensagem deve conter o path da worktree");
  assert.ok(fs.existsSync(pathMatch[1]), "a worktree ainda deve existir em disco para recuperação manual");
});

test("write:true, worktree:true com allowWrites:false falha antes de runTurn — nenhuma worktree é criada", async () => {
  const cwd = setup();
  let called = false;
  const runInner = async () => {
    called = true;
    return { ok: true, output: "x", threadId: null, touchedFiles: [] };
  };
  const e = relay.enqueue(cwd, { requestId: "iso-4", to: "codex", payload: { prompt: "p", write: true, worktree: true } });
  const c = relay.claim(cwd, e.jobId, "w1", 5000);
  const r = await worker.processJob(cwd, c.job, c.claimToken, { runTurn: withWorktreeIsolation(runInner), allowWrites: false });
  assert.equal(r.outcome, "failed");
  assert.equal(called, false);
  const list = git(cwd, ["worktree", "list", "--porcelain"]);
  const count = (list.stdout.match(/^worktree /gm) || []).length;
  assert.equal(count, 1, "só o worktree principal deve existir");
});
