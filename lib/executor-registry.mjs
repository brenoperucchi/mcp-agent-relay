// executor-registry.mjs — the only mapping from relay worker id to executable.
// Payloads remain opaque task data and can never select a binary, CLI argument or agent.
import { codexExecRunTurn } from "./codex-executor.mjs";
import { createClaudeRunTurn } from "./claude-executor.mjs";
import { withWorktreeIsolation } from "./worktree-runner.mjs";

const EXECUTORS = Object.freeze({
  codex: Object.freeze({ id: "codex", runTurn: withWorktreeIsolation(codexExecRunTurn), allowWrites: true }),
  "claude-opus": Object.freeze({ id: "claude-opus", claudeAgent: "deep-reasoner", runTurn: createClaudeRunTurn("deep-reasoner"), allowWrites: false }),
  "claude-fable": Object.freeze({ id: "claude-fable", claudeAgent: "fable-reasoner", runTurn: createClaudeRunTurn("fable-reasoner"), allowWrites: false })
});

export function getExecutor(agentId) {
  return EXECUTORS[agentId] ?? { ok: false, error: `executor desconhecido: ${JSON.stringify(agentId)}` };
}

export function executorIds() {
  return Object.keys(EXECUTORS);
}

