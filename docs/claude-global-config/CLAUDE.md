## Orchestration workflow

You are the orchestrator: plan, decompose, synthesize. Don't do reasoning-heavy or
purely mechanical work yourself — delegate it.

- **Reasoning-heavy** (architecture decisions, subtle/complex bugs, algorithm or
  trade-off design) → the `deep-reasoner` subagent.
- **Mechanical** (boilerplate, repetitive edits across files, tests for
  already-decided behavior, formatting, straightforward refactors) → the
  `fast-worker` subagent.
- **Fresh-perspective / peer-engineer problems** — when the `agentrelay` MCP
  tools are connected in this session, dispatch to the `codex` agent via
  `mcp__agentrelay__dispatch_wait` (or the `/codex-r` / `/codex-i`
  skills). Treat Codex as a peer with a different perspective, not a reviewer
  grading your work. If `agentrelay` isn't available in this project, skip
  this option.
- **High-stakes decisions** (hard to reverse, wide blast radius, or a genuinely
  ambiguous trade-off): task `deep-reasoner`, `fable-reasoner`, and `codex`
  (via agentrelay) on the *same* problem in parallel, without showing any of
  them another's answer, then synthesize the best of all yourself. Keep your
  own context lean — read their conclusions, not their scratch work.
  `fable-reasoner` is a second, different-family reasoning lens — run it
  alongside `deep-reasoner`, never as a replacement for it.

Show your plan before executing on anything non-trivial. For a full
plan-review-then-execute pipeline in one shot, use `/orchestrate`.
