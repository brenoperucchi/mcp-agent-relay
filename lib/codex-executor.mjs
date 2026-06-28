// codex-executor.mjs — default `runTurn` for the relay worker: runs a Codex turn
// non-interactively via the `codex` CLI (`codex exec`). Self-contained — only needs
// the `codex` binary on PATH. Pass your own `runTurn` to the worker to swap it.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const MODEL_ALIASES = { spark: "gpt-5.3-codex-spark" };

export function codexExecRunTurn(cwd, { prompt, model, write = false, signal } = {}) {
  return new Promise((resolve) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "relay-codex-"));
    const outFile = path.join(tmp, "last.txt");
    const sandbox = write ? "workspace-write" : "read-only";
    const args = ["exec", "-s", sandbox, "-C", cwd, "--skip-git-repo-check", "--output-last-message", outFile];
    const resolvedModel = model ? MODEL_ALIASES[model] ?? model : null;
    if (resolvedModel) {
      args.push("-m", resolvedModel);
    }
    args.push(prompt);

    const child = spawn("codex", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    if (signal) {
      const onAbort = () => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    child.on("error", (err) => {
      cleanup(tmp);
      resolve({ ok: false, output: null, threadId: null, touchedFiles: [], error: err.message });
    });
    child.on("close", (code) => {
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
