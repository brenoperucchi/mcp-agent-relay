# mcp-agent-relay

**A durable, MCP-native job relay.** Agents dispatch work to each other; a Claude Code
session is *woken* — via a [channel](#the-channel-no-more-tmux) — the moment a job finishes.
No `tmux send-keys`, no file-watching daemon, no point-to-point socket to keep alive.

> Status: **v0.1 — research preview.** The store, MCP facade, and worker are covered by 63
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

The plugin declares the relay MCP server in [`.mcp.json`](.mcp.json); Claude Code auto-connects
it at session start.

### As a raw MCP server (any MCP client)

```jsonc
// .mcp.json in your project
{
  "mcpServers": {
    "relay": {
      "command": "node",
      "args": ["/path/to/mcp-agent-relay/server.mjs"],
      "env": { "RELAY_AGENT": "claude-main" }
    }
  }
}
```

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
```

Write jobs are **deny-by-default** (`--allow-writes` to opt in). A write job whose lease expires
is parked as `needs_recovery` — never silently re-run.

### The channel (no more tmux)

To have a *running* Claude session woken when a job it dispatched finishes:

```bash
RELAY_AGENT=claude-main claude --dangerously-load-development-channels server:relay
```

When a terminal job (`from === RELAY_AGENT`) finishes, or a new job lands in this agent's inbox
(`to === RELAY_AGENT`), the server emits `notifications/claude/channel`. It arrives as
`<channel source="relay">…</channel>` and Claude acts on it — typically by calling `poll`.

**Injection-safe:** the channel content is a minimal envelope (`job_id`, `state`) telling Claude
to `poll` for the result. The untrusted job payload is **never** placed in the channel content.

---

## Swap the executor

The worker calls a `runTurn(cwd, { prompt, model, write, signal })` function. The default
(`lib/codex-executor.mjs`) runs `codex exec -s read-only|workspace-write …` and returns the
final message via `--output-last-message`. To target a different backend, pass your own
`runTurn` when constructing the worker — the relay, channel, and durability guarantees are
unchanged.

---

## Requirements & caveats

- **Node ≥ 18.18.** No runtime dependencies.
- **Default executor needs the `codex` CLI** on `PATH`. Swap it (above) to run anything else.
- **The channel is a Claude Code research preview:** needs Claude Code ≥ 2.1.80, Anthropic auth
  (not Bedrock/Vertex), and the `--dangerously-load-development-channels` flag. The relay is
  fully usable *without* the channel — `poll` and the inbox resource are always the source of
  truth; the channel is a wake-up signal, not the system of record.
- **Single machine, v0.1.** The store is file-backed and coordinated by an interprocess lock.
  Multi-machine (shared substrate + cross-agent auth) is a deliberate future phase, not a
  redesign — the routing model (identity + inbox + claim) already accounts for it.

## Development

```bash
node --test        # 63 tests: store, facade + channel, worker
```

## License

MIT
