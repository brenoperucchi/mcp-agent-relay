# mcp-agent-relay

**A durable, MCP-native job relay.** Agents dispatch work to each other; a Claude Code
session is *woken* — via a [channel](#the-channel-no-more-tmux) — the moment a job finishes.
No `tmux send-keys`, no file-watching daemon, no point-to-point socket to keep alive.

> Status: **v0.1 — research preview.** The store, MCP facade, and worker are covered by 86
> tests. The "wake a running session" channel rides on a Claude Code research-preview feature
> (see [caveats](#requirements--caveats)).

---

## The problem it solves

When one agent hands work to another, two hard parts hide behind "just send a message":

1. **Durability.** If the relay process dies mid-job, the job and its result must survive — no
   lost work, no double-execution, no "did that actually run?".
2. **The trigger.** An interactive CLI session (Claude Code) can't be *called* like a server.
   The old answer was a daemon that injected keystrokes into the terminal with `tmux send-keys`.
   Fragile, invisible, easy to break.

`mcp-agent-relay` answers both with one design: a **file-durable job store** behind a **standard
MCP facade**, plus a **channel** that pushes a "job done" signal straight into a running session.

The asymmetry it leans on: a **server** (e.g. Codex) is *driven* by a worker; an **interactive
session** (Claude) is *woken* by a channel. Same relay, two ends.

---

## Architecture

```
  agent A (MCP client)        RELAY (durable, file-backed)        worker / executor
    │  dispatch(to,task,        │                                    │
    │           request_id)     │  enqueue → dedup by request_id     │
    ├──────────────────────────►│  job_id (atomic write + lock)      │
    │         job_id            │                                    │
    │◄──────────────────────────┤                                    │
    │  poll(job_id)             │  claim (lease + fencing token) ───►│ runTurn()
    │                           │  complete(result) BEFORE replying  │  e.g. `codex exec`
    │◄──── result ──────────────┤◄───────────────────────────────────┤
    │                           │
    │   ⟵ channel: "job done" pushed into agent A's running session ⟵
```

Four layers, each independently testable:

| Layer | File | What it owns |
|---|---|---|
| **Store** | `lib/relay-jobs.mjs` | durable queue: atomic writes, interprocess lock, leases, fencing tokens, `request_id` dedup, TTL sweep, write-safety (`needs_recovery`) |
| **Facade** | `server.mjs` | MCP stdio server: `register_agent` / `dispatch` / `poll` + inbox resources + the channel |
| **Worker** | `lib/relay-worker.mjs` | claims jobs, runs them with heartbeat + cooperative cancel, completes durably |
| **Executor** | `lib/codex-executor.mjs` | the default `runTurn` — runs a Codex turn via the `codex` CLI. Swappable. |

---

## Install

### As a Claude Code plugin

```bash
claude plugin marketplace add <your-org>/mcp-agent-relay
claude plugin install mcp-agent-relay
```

The plugin declares the `agentrelay` MCP server in [`.mcp.json`](.mcp.json); Claude Code
auto-connects it at session start. Installing the plugin (vs. a bare `claude mcp add`) also
ships the slash command below.

#### Slash command: review a file with Codex

Once the plugin is installed, `/mcp-agent-relay:review <path> [focus notes]` dispatches an
adversarial review of the file to the `codex` worker through the relay and waits for the verdict —
synchronous from your side (dispatch → poll → result). Codex reads the file itself (read-only over
the workspace); you don't paste its contents. Requires a worker to execute the job (the daemon
auto-spawns when `RELAY_WORKER_AUTOSPAWN` is set for the server — the launcher and the plugin's
`.mcp.json` set it).

### As a bare MCP server (Claude Code `mcp add`)

```bash
claude mcp add --scope user agentrelay \
  node /path/to/mcp-agent-relay/server.mjs \
  -e RELAY_AGENT=claude-main \
  -e RELAY_WORKER_AUTOSPAWN=1 \
  -e RELAY_WORKER_AGENTS=codex
```

The store defaults to `~/.mcp-agent-relay/state`. Override with `-e RELAY_DATA_DIR=/your/path`.

Then launch Claude with the bare channel flag — use `bin/claude-relay --bare` (or directly):

```bash
claude --dangerously-load-development-channels server:agentrelay
```

> **Plugin vs. bare install change the tool names and channel flag.**
>
> | | Plugin install | Bare `mcp add` |
> |---|---|---|
> | Tools | `mcp__plugin_mcp-agent-relay_agentrelay__dispatch` | `mcp__agentrelay__dispatch` |
> | Channel flag | `plugin:mcp-agent-relay@mcp-agent-relay` | `server:agentrelay` |
> | `claude-relay` | `claude-relay` | `claude-relay --bare` |
>
> The `<channel source="agentrelay">` tag is the same in both cases.

No build step, no runtime dependencies — Node ≥ 18.18 and the standard library only.

---

## Usage

### Dispatch and poll (the async base)

`dispatch` returns a `job_id` immediately and is idempotent by `request_id`:

```jsonc
// tool: dispatch
{ "to": "codex", "task": { "prompt": "review the diff" }, "request_id": "req-1" }
// → { "job_id": "relay-…", "deduped": false, "state": "queued" }

// tool: poll
{ "job_id": "relay-…" }
// → { "found": true, "state": "completed", "result": { … }, "attempts": 1 }
```

### Run a worker (the execution side)

The worker claims queued jobs and runs them. The default executor shells out to `codex exec`:

```bash
# drain once and exit
node worker.mjs --agent codex --once

# long-running loop, allowed to run write jobs
node worker.mjs --agent codex --allow-writes --interval 1000

# exit automatically after 5 minutes of idleness (no queued jobs)
node worker.mjs --agent codex --idle-timeout 300000
```

Write jobs are **deny-by-default** (`--allow-writes` to opt in). A write job whose lease expires
is parked as `needs_recovery` — never silently re-run.

`--idle-timeout <ms>` makes the worker exit after that many milliseconds with no jobs processed.
Omit it (or pass `0`) to run until SIGINT/SIGTERM. Useful for ephemeral workers spawned on demand.

### The channel (no more tmux)

To have a *running* Claude session woken when a job it dispatched finishes:

```bash
# plugin install:
RELAY_AGENT=claude-main claude --dangerously-load-development-channels plugin:mcp-agent-relay@mcp-agent-relay
# bare `claude mcp add agentrelay` install instead:
RELAY_AGENT=claude-main claude --dangerously-load-development-channels server:agentrelay
# or just: bin/claude-relay   (wraps the plugin flag + sets RELAY_AGENT and worker auto-spawn)
```

When a terminal job (`from === RELAY_AGENT`) finishes, or a new job lands in this agent's inbox
(`to === RELAY_AGENT`), the server emits `notifications/claude/channel`. It arrives as
`<channel source="agentrelay">…</channel>` and Claude acts on it — typically by calling the
agentrelay `poll` tool.

**Injection-safe:** the channel content is a minimal envelope (`job_id`, `state`) telling Claude
to `poll` for the result. The untrusted job payload is **never** placed in the channel content.

### The Stop hook (wake-up without the channel flag)

The channel is the only *push* path Claude Code exposes, but it needs
`--dangerously-load-development-channels` (a per-session confirmation dialog) and is silently
broken for bare `server:` channels on recent builds
([anthropics/claude-code#71792](https://github.com/anthropics/claude-code/issues/71792)). The
**Stop hook** is the pull-side equivalent: when Claude is about to end its turn, the hook
inspects the relay store and — if a job this agent dispatched finished, or a new job landed in
its inbox — blocks the stop and feeds Claude a reason, giving it one more turn to `poll`. No
flag, no dialog; works with a plain `claude mcp add` or plugin install.

Wire it with the helper (idempotent; merges into project `.claude/settings.json`, `--global` for
`~/.claude/settings.json`, `--remove` to tear out, `--print` to preview):

```bash
node bin/relay-install-hook.mjs            # project .claude/settings.json
node bin/relay-install-hook.mjs --global   # ~/.claude/settings.json
```

Or wire the **same** command by hand on two events (`SessionStart` seeds the baseline so the
first stop isn't flooded with old jobs; `Stop` surfaces new transitions — full example in
[`docs/examples/settings.hooks.json`](docs/examples/settings.hooks.json)):

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command",
      "command": "node /ABS/PATH/mcp-agent-relay/bin/relay-stop-hook.mjs" }] }],
    "Stop": [{ "hooks": [{ "type": "command",
      "command": "node /ABS/PATH/mcp-agent-relay/bin/relay-stop-hook.mjs" }] }]
  }
}
```

Requires `RELAY_AGENT` in the environment (the session identity) — without it the hook is a
silent no-op, exactly like the channel with no agent id. Event parity with the channel is exact:
a terminal job with `from === RELAY_AGENT`, or a queued job with `to === RELAY_AGENT`. Optional
knobs: `RELAY_HOOK_WAIT_MS>0` makes a stop **long-poll** (bounded) for an in-flight dispatch to
finish instead of settling immediately; `RELAY_HOOK_POLL_MS` tunes the poll interval. The hook
**fails open** — any internal error allows the stop, never wedging the session.

> **The hook must resolve the same store as the MCP server.** Both derive the state dir from
> `RELAY_DATA_DIR` (or `$CLAUDE_PLUGIN_DATA/state`, then `~/.mcp-agent-relay/state`) plus the
> workspace slug. Claude Code launches hooks with the session environment, so they line up by
> default — but if you set `RELAY_DATA_DIR` for the server, set the *same* value for the hook, or
> it will read an empty store and never wake. (Do **not** point `RELAY_DATA_DIR` at an
> unexpanded `${RELAY_DATA_DIR}` — that lands the store in a literal `${RELAY_DATA_DIR}/` folder
> under your cwd.)

| Path | Dialog | Inbound on recent builds | Install |
| --- | --- | --- | --- |
| Channel (`--dangerously-load-development-channels`) | yes | broken (#71792) | `bin/claude-relay` |
| **Stop hook** | **no** | **works** | `claude mcp add` / plugin + 2 hook lines |

---

## Swap the executor

The worker calls a `runTurn(cwd, { prompt, model, write, worktree, jobId, signal })` function.
The default (`lib/codex-executor.mjs`) runs `codex exec -s read-only|workspace-write …` and
returns the final message via `--output-last-message`. To target a different backend, pass your
own `runTurn` when constructing the worker — the relay, channel, and durability guarantees are
unchanged.

---

## Write jobs in an isolated worktree

Set `worktree: true` alongside `write: true` in the task payload to run the turn inside a fresh
`git worktree` (a new branch off the caller's `HEAD`) instead of the main working tree:

```json
{ "prompt": "implement TASK-192", "write": true, "worktree": true }
```

This is layered on top of `lib/codex-executor.mjs` by `lib/worktree-runner.mjs` — no separate
flag or process is needed. The job's `result.worktree` (`{ path, branch, baseSha }`) tells the
caller where to review and merge the diff by hand; nothing is merged automatically. If the turn
makes no change at all (no uncommitted diff, `HEAD` unmoved), the worktree and branch are removed
automatically. If it fails or times out (parked as `needs_recovery`) *after* making a change, the
worktree is preserved and the job's error message includes its path for manual recovery.

**Caveat:** the worktree branches from the last **commit**, not from any uncommitted state in the
main working tree — a real behavior difference from running the turn directly in `cwd`.

---

## Requirements & caveats

- **Node ≥ 18.18.** No runtime dependencies.
- **Default executor needs the `codex` CLI** on `PATH`. Swap it (above) to run anything else.
- **The channel is a Claude Code research preview:** needs Claude Code ≥ 2.1.80, Anthropic auth
  (not Bedrock/Vertex), and the `--dangerously-load-development-channels` flag. The relay is
  fully usable *without* the channel — `poll` and the inbox resource are always the source of
  truth; the channel is a wake-up signal, not the system of record.
- **Prefer the Stop hook for hands-free wake-up on current builds:** the channel flag is broken
  for bare `server:` channels on recent Claude Code ([#71792](https://github.com/anthropics/claude-code/issues/71792)).
  The Stop hook (above) needs no flag or dialog and works with a plain `mcp add` / plugin install.
- **Single machine, v0.1.** The store is file-backed and coordinated by an interprocess lock.
  Multi-machine (shared substrate + cross-agent auth) is a deliberate future phase, not a
  redesign — the routing model (identity + inbox + claim) already accounts for it.

## Development

```bash
node --test        # 86 tests: store, facade + channel, worker
```

## License

MIT
