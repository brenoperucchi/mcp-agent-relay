// worktree-runner.mjs — decorates a `runTurn(cwd, opts)` so a write turn can
// optionally run inside an isolated git worktree/branch instead of the main
// working tree, when `opts.write && opts.worktree`. Pass-through otherwise.
//
// "No changes" must check TWO signals, not just a clean `git status`: if the
// inner turn ran `git commit` itself, the working tree is clean but HEAD has
// moved past the base commit — that IS a change, and must not be discarded.
//
// A fresh worktree id is generated per RUN ATTEMPT (not per job id), so a
// park -> recover -> reclaim retry never collides with a prior attempt's
// worktree/branch — that one is simply left on disk for manual inspection.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { generateJobId, resolveWorktreesDir } from "./store-paths.mjs";

const BRANCH_PREFIX = "relay/";

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function failure(error) {
  return { ok: false, output: null, threadId: null, touchedFiles: [], error };
}

export function withWorktreeIsolation(runInner) {
  return async function runTurn(cwd, opts = {}) {
    if (!opts.write || !opts.worktree) {
      return runInner(cwd, opts);
    }

    try {
      const base = git(cwd, ["rev-parse", "HEAD"]);
      if (base.status !== 0) {
        return failure(`worktree: HEAD indisponível em ${cwd}: ${base.stderr?.trim() || "sem commits?"}`);
      }
      const baseSha = base.stdout.trim();

      const worktreeId = generateJobId(opts.jobId || "relay-worktree");
      const worktreesDir = resolveWorktreesDir(cwd);
      fs.mkdirSync(worktreesDir, { recursive: true });
      const worktreePath = path.join(worktreesDir, worktreeId);
      const branch = `${BRANCH_PREFIX}${worktreeId}`;

      const add = git(cwd, ["worktree", "add", "-b", branch, worktreePath, baseSha]);
      if (add.status !== 0) {
        return failure(`worktree add falhou: ${add.stderr?.trim() || add.error?.message}`);
      }

      let result;
      try {
        result = await runInner(worktreePath, opts);
      } catch (err) {
        result = failure(err?.message ?? String(err));
      }

      const status = git(worktreePath, ["status", "--porcelain"]);
      const head = git(worktreePath, ["rev-parse", "HEAD"]);
      const dirty = (status.stdout || "").trim() !== "";
      const advanced = head.status === 0 && head.stdout.trim() !== baseSha;

      if (!dirty && !advanced) {
        const rm = git(cwd, ["worktree", "remove", "--force", worktreePath]);
        if (rm.status !== 0) {
          return { ...result, worktree: { path: worktreePath, branch, cleanupFailed: true } };
        }
        git(cwd, ["branch", "-D", branch]);
        return result;
      }

      return { ...result, worktree: { path: worktreePath, branch, baseSha } };
    } catch (err) {
      return failure(`worktree: erro inesperado: ${err?.message ?? String(err)}`);
    }
  };
}
