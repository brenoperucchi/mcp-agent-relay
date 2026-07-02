import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { withWorktreeIsolation } from "../lib/worktree-runner.mjs";

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-worktree-repo-"));
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
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "relay-worktree-data-"));
  return initRepo();
}

test("passthrough quando write é falso: runInner roda no cwd original", async () => {
  const cwd = setup();
  let called = null;
  const runInner = async (c) => {
    called = c;
    return { ok: true, output: "x", threadId: null, touchedFiles: [] };
  };
  const result = await withWorktreeIsolation(runInner)(cwd, { write: false, worktree: true, prompt: "p" });
  assert.equal(result.ok, true);
  assert.equal(called, cwd);
  assert.equal(result.worktree, undefined);
});

test("passthrough quando worktree é falso: runInner roda no cwd original", async () => {
  const cwd = setup();
  let called = null;
  const runInner = async (c) => {
    called = c;
    return { ok: true, output: "x", threadId: null, touchedFiles: [] };
  };
  const result = await withWorktreeIsolation(runInner)(cwd, { write: true, worktree: false, prompt: "p" });
  assert.equal(called, cwd);
  assert.equal(result.worktree, undefined);
});

test("sem mudanças: worktree e branch são removidas, result.worktree ausente", async () => {
  const cwd = setup();
  const runInner = async () => ({ ok: true, output: "done", threadId: null, touchedFiles: [] });
  const result = await withWorktreeIsolation(runInner)(cwd, { write: true, worktree: true, jobId: "job-1", prompt: "p" });
  assert.equal(result.ok, true);
  assert.equal(result.worktree, undefined);
  const list = git(cwd, ["worktree", "list", "--porcelain"]);
  assert.equal(list.stdout.includes("job-1"), false);
});

test("com mudanças não commitadas: worktree mantida com path/branch corretos", async () => {
  const cwd = setup();
  const runInner = async (wtCwd) => {
    fs.writeFileSync(path.join(wtCwd, "new.txt"), "hi\n");
    return { ok: true, output: "done", threadId: null, touchedFiles: ["new.txt"] };
  };
  const result = await withWorktreeIsolation(runInner)(cwd, { write: true, worktree: true, jobId: "job-2", prompt: "p" });
  assert.equal(result.ok, true);
  assert.ok(result.worktree);
  assert.ok(fs.existsSync(result.worktree.path));
  assert.ok(result.worktree.branch.startsWith("relay/"));
  assert.ok(fs.existsSync(path.join(result.worktree.path, "new.txt")));
});

test("regressão: runInner commita sozinho (árvore limpa) — worktree deve ser mantida", async () => {
  const cwd = setup();
  const runInner = async (wtCwd) => {
    fs.writeFileSync(path.join(wtCwd, "committed.txt"), "hi\n");
    git(wtCwd, ["add", "."]);
    git(wtCwd, ["commit", "-q", "-m", "auto"]);
    return { ok: true, output: "done", threadId: null, touchedFiles: [] };
  };
  const result = await withWorktreeIsolation(runInner)(cwd, { write: true, worktree: true, jobId: "job-3", prompt: "p" });
  assert.ok(result.worktree, "worktree deve sobreviver mesmo com árvore limpa, pois HEAD avançou");
  assert.ok(fs.existsSync(result.worktree.path));
});

test("runInner falha sem mudanças: worktree é limpa mesmo assim", async () => {
  const cwd = setup();
  const runInner = async () => ({ ok: false, output: null, threadId: null, touchedFiles: [], error: "boom" });
  const result = await withWorktreeIsolation(runInner)(cwd, { write: true, worktree: true, jobId: "job-4", prompt: "p" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "boom");
  assert.equal(result.worktree, undefined);
});

test("runInner falha mas escreveu algo antes: worktree mantida junto do erro", async () => {
  const cwd = setup();
  const runInner = async (wtCwd) => {
    fs.writeFileSync(path.join(wtCwd, "partial.txt"), "oops\n");
    return { ok: false, output: null, threadId: null, touchedFiles: [], error: "boom" };
  };
  const result = await withWorktreeIsolation(runInner)(cwd, { write: true, worktree: true, jobId: "job-5", prompt: "p" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "boom");
  assert.ok(result.worktree);
  assert.ok(fs.existsSync(result.worktree.path));
});

test("runInner lança exceção: wrapper nunca rejeita, resolve ok:false", async () => {
  const cwd = setup();
  const runInner = async () => {
    throw new Error("kaboom");
  };
  const result = await withWorktreeIsolation(runInner)(cwd, { write: true, worktree: true, jobId: "job-6", prompt: "p" });
  assert.equal(result.ok, false);
  assert.match(result.error, /kaboom/);
});

test("repo sem commits: git worktree add falha, runInner nunca é chamado", async () => {
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "relay-worktree-data-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "relay-worktree-empty-"));
  git(cwd, ["init", "-q"]);
  let called = false;
  const runInner = async () => {
    called = true;
    return { ok: true, output: "x", threadId: null, touchedFiles: [] };
  };
  const result = await withWorktreeIsolation(runInner)(cwd, { write: true, worktree: true, jobId: "job-7", prompt: "p" });
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test("duas tentativas com o mesmo jobId (park→recover→reclaim) não colidem", async () => {
  const cwd = setup();
  const runInner = async (wtCwd) => {
    fs.writeFileSync(path.join(wtCwd, "x.txt"), "x\n");
    return { ok: true, output: "done", threadId: null, touchedFiles: [] };
  };
  const runTurn = withWorktreeIsolation(runInner);
  const r1 = await runTurn(cwd, { write: true, worktree: true, jobId: "same-job", prompt: "p" });
  const r2 = await runTurn(cwd, { write: true, worktree: true, jobId: "same-job", prompt: "p" });
  assert.notEqual(r1.worktree.path, r2.worktree.path);
  assert.notEqual(r1.worktree.branch, r2.worktree.branch);
});

test("falha no cleanup é não-fatal (cleanupFailed: true, sem throw)", async () => {
  const cwd = setup();
  const runInner = async (wtCwd) => {
    git(wtCwd, ["worktree", "lock", wtCwd]);
    return { ok: true, output: "done", threadId: null, touchedFiles: [] };
  };
  const result = await withWorktreeIsolation(runInner)(cwd, { write: true, worktree: true, jobId: "job-8", prompt: "p" });
  assert.equal(result.ok, true);
  assert.ok(result.worktree);
  assert.equal(result.worktree.cleanupFailed, true);
});
