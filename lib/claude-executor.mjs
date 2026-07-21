// claude-executor.mjs — allowlisted, non-interactive Claude Code adapter.
//
// The registry, not a job payload, chooses the Claude agent. Claude write turns are
// rejected by relay-worker before reaching here; `plan` is an additional CLI guard.
import { spawn } from "node:child_process";

export const ABORT_GRACE_MS = 2000;

function safeEnv(env) {
  const allowed = [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "TMPDIR"
  ];
  return Object.fromEntries(allowed.filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));
}

function killGroup(child, signal, killImpl) {
  const pid = child.pid;
  if (process.platform !== "win32" && Number.isInteger(pid) && pid > 1) {
    try {
      killImpl(-pid, signal);
      return;
    } catch {
      // The group may already have exited; fall through to the direct handle.
    }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}

// Factory makes process creation injectable: tests never require a Claude account/CLI.
export function createClaudeRunTurn(agent, { spawnImpl = spawn, killImpl = process.kill, env = process.env } = {}) {
  if (typeof agent !== "string" || !agent) throw new Error("Claude agent obrigatório");
  return function claudeRunTurn(cwd, { prompt, signal } = {}) {
    return new Promise((resolve) => {
      // Do not accept command/args/agent/env from the payload. This is the complete CLI.
      // `--` keeps a prompt such as "--help" from becoming a Claude CLI option.
      const args = ["-p", "--agent", agent, "--permission-mode", "plan", "--", String(prompt ?? "")];
      let child;
      try {
        child = spawnImpl("claude", args, {
          cwd,
          env: safeEnv(env),
          stdio: ["ignore", "pipe", "pipe"],
          detached: true
        });
      } catch (err) {
        resolve({ ok: false, output: null, threadId: null, touchedFiles: [], error: err?.message ?? String(err) });
        return;
      }
      let stdout = "";
      let stderr = "";
      let settled = false;
      let killTimer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => {
        killGroup(child, "SIGTERM", killImpl);
        killTimer = setTimeout(() => killGroup(child, "SIGKILL", killImpl), ABORT_GRACE_MS);
        killTimer.unref?.();
      };
      child.stdout?.on("data", (data) => { stdout += data.toString(); });
      child.stderr?.on("data", (data) => { stderr += data.toString(); });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (err) => {
        finish({ ok: false, output: null, threadId: null, touchedFiles: [], error: err?.message ?? String(err) });
      });
      child.on("close", (code) => {
        const output = stdout.trim() || null;
        const ok = code === 0 && output !== null;
        finish({
          ok,
          output,
          threadId: null,
          touchedFiles: [],
          error: ok ? null : stderr.trim() || (code === 0 ? "claude terminou sem resposta final" : `claude -p exited with code ${code}`)
        });
      });
    });
  };
}
