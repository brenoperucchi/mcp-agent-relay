// codex-executor.mjs — default `runTurn` for the relay worker: runs a Codex turn
// non-interactively via the `codex` CLI (`codex exec`). Self-contained — only needs
// the `codex` binary on PATH. Pass your own `runTurn` to the worker to swap it.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const MODEL_ALIASES = { spark: "gpt-5.3-codex-spark" };

// On abort we SIGTERM the whole process group, then SIGKILL it after this grace if codex
// (or one of its children) ignores the term — so the turn always settles bounded.
export const ABORT_GRACE_MS = 2000;

// Signal the child's PROCESS GROUP (POSIX: `kill(-pid)`), so codex's own children die too.
// Falls back to the direct child handle where a group kill can't apply (non-POSIX, or the
// group is already gone). Never group-signals an unsafe pid (0/1/negative).
function killGroup(child, signal) {
  const pid = child.pid;
  if (process.platform !== "win32" && Number.isInteger(pid) && pid > 1) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      /* group gone — fall through to the direct child handle */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
}

export function codexExecRunTurn(cwd, { prompt, model, effort, write = false, signal } = {}) {
  return new Promise((resolve) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "relay-codex-"));
    const outFile = path.join(tmp, "last.txt");
    const sandbox = write ? "workspace-write" : "read-only";
    const args = ["exec", "-s", sandbox, "-C", cwd, "--skip-git-repo-check", "--output-last-message", outFile];
    const resolvedModel = model ? MODEL_ALIASES[model] ?? model : null;
    if (resolvedModel) {
      args.push("-m", resolvedModel);
    }
    if (effort) {
      args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
    }
    args.push(prompt);

    // `detached: true` makes the child its own process-group leader so we can group-kill
    // it (and codex's grandchildren) on abort. We do NOT unref — we await its `close`.
    const child = spawn("codex", args, { cwd, stdio: ["ignore", "ignore", "pipe"], detached: true });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    let killTimer = null;
    const clearKillTimer = () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };
    if (signal) {
      const onAbort = () => {
        killGroup(child, "SIGTERM");
        // Bounded escalation: if it ignores SIGTERM, SIGKILL the group after the grace.
        killTimer = setTimeout(() => killGroup(child, "SIGKILL"), ABORT_GRACE_MS);
        killTimer.unref?.(); // never keep the worker process alive on this timer
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    child.on("error", (err) => {
      clearKillTimer();
      cleanup(tmp);
      resolve({ ok: false, output: null, threadId: null, touchedFiles: [], error: err.message });
    });
    child.on("close", (code) => {
      clearKillTimer();
      let output = null;
      try {
        output = readFileSync(outFile, "utf8").trim() || null;
      } catch {
        /* no output file */
      }
      cleanup(tmp);
      const ok = code === 0 && output != null;
      resolve({
        ok,
        output,
        threadId: null,
        touchedFiles: [],
        error: ok ? null : stderr.trim() || `codex exec exited with code ${code}`
      });
    });
  });
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
