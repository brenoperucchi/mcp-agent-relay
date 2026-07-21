# mcp-agent-relay

**Durable MCP dispatch for explicit CLI executors.**

`mcp-agent-relay` lets one MCP client hand a job to a locally installed CLI agent and retrieve a durable result. It keeps the queue, state, leases, cancellation, and review policy in one MCP-native relay while delegating each turn to a small, allowlisted executor adapter.

It is designed for a practical local workflow: Codex can request an independent read-only review from Codex, Claude Opus, or Claude Fable without turning the relay into a remote shell.

> Status: **research preview / single-machine relay.** The durable queue and executor adapters are production-shaped; wake-up integration with Claude Code depends on Claude Code preview capabilities.

## Why use it?

The hard part of agent-to-agent work is not starting a command. It is retaining a correct answer when processes restart, jobs collide, a worker loses its lease, or a caller gives up waiting.

The relay provides:

- **Durable dispatch.** File-backed jobs survive server and worker restarts. A `request_id` makes dispatch idempotent.
- **Explicit routing.** The `to` field selects one allowlisted worker id; it cannot select a binary, arguments, Claude agent, or environment.
- **Safe execution defaults.** Jobs are read-only by default. Codex writes require an explicit worker opt-in; Claude writes are rejected in this release.
- **Correct worker coordination.** Workers claim jobs using leases, fencing tokens, heartbeats, cancellation, timeout handling, and recovery states.
- **MCP-first integration.** Any MCP client can `dispatch`, `poll`, or `dispatch_wait`. A running Claude Code session can also be notified when a job changes state.

## At a glance

| Need | Use |
| --- | --- |
| Quick read-only review with Codex | `to: "codex"` |
| Deep Claude review with the local `deep-reasoner` agent | `to: "claude-opus"` |
| Independent Claude review with the local `fable-reasoner` agent | `to: "claude-fable"` |
| Wait for one result in the tool call | `dispatch_wait` |
| Submit now and inspect later | `dispatch` then `poll` |
| Make a Codex change in an isolated worktree | `write: true, worktree: true` and a Codex worker started with `--allow-writes` |

## Architecture

~~~
MCP client                         durable relay                         worker
──────────                         ─────────────                         ──────
dispatch(to, task, request_id) ──▶ queue + request-id dedup
                                  claim + lease + fencing ───────────▶ adapter.runTurn()
poll(job_id)                 ◀─── terminal result ◀────────────────── Codex or Claude CLI
                                  state is completed before it is returned
~~~

| Layer | Responsibility |
| --- | --- |
| `lib/relay-jobs.mjs` | Durable queue, locking, deduplication, leases, fencing, expiry, cancellation, recovery, and review state |
| `server.mjs` | MCP stdio facade, inbox resources, synchronous wait, and optional Claude channel |
| `lib/relay-worker.mjs` | Claim loop, heartbeat, timeout, cancellation, worktree orchestration, and durable completion |
| `lib/executor-registry.mjs` | Central allowlist from worker id to an adapter and its fixed configuration |
| `lib/codex-executor.mjs` / `lib/claude-executor.mjs` | One isolated CLI turn with output collection and process-group shutdown |

The executor boundary is deliberately narrow: the relay is **executor-agnostic**, not **command-agnostic**.

## Available executors

| Worker id / `to` | Adapter | Fixed invocation | Write policy |
| --- | --- | --- | --- |
| `codex` | Codex CLI | `codex exec` | Denied unless that worker has `--allow-writes` |
| `claude-opus` | Claude Code | `claude -p --agent deep-reasoner --permission-mode plan -- <prompt>` | Always rejected |
| `claude-fable` | Claude Code | `claude -p --agent fable-reasoner --permission-mode plan -- <prompt>` | Always rejected |

For the Claude routes, the local Claude Code installation must already be authenticated and must have the corresponding agent definitions:

~~~
~/.claude/agents/deep-reasoner
~/.claude/agents/fable-reasoner
~~~

The `--` delimiter ensures a prompt cannot be parsed as a Claude CLI option. Payload fields such as `command`, `args`, `agent`, and environment settings do not alter the registry mapping.

## Quick start: connect Codex

### 1. Clone the relay and verify Node

~~~bash
git clone https://github.com/brenoperucchi/mcp-agent-relay.git
cd mcp-agent-relay
node --version  # Node 18.18 or newer
~~~

No package installation or build step is required.

### 2. Register the MCP server

Register a global Codex MCP server, or put the equivalent configuration in a trusted project if it should be project-scoped:

~~~bash
codex mcp add agentrelay \
  --env RELAY_WORKER_AUTOSPAWN=1 \
  --env RELAY_WORKER_AGENTS=codex,claude-opus,claude-fable \
  -- node /absolute/path/to/mcp-agent-relay/server.mjs
~~~

If a CLI is installed outside the inherited environment, provide a minimal explicit `PATH` for the relay process:

~~~bash
codex mcp add agentrelay \
  --env PATH=/home/you/.local/bin:/usr/local/bin:/usr/bin:/bin \
  --env RELAY_WORKER_AUTOSPAWN=1 \
  --env RELAY_WORKER_AGENTS=codex,claude-opus,claude-fable \
  -- node /absolute/path/to/mcp-agent-relay/server.mjs
~~~

Confirm the registration:

~~~bash
codex mcp list
~~~

When the server receives a job, autospawn starts one short-lived worker per configured executor id as needed. You can instead run workers yourself; see [Running workers](#running-workers).

### 3. Dispatch a read-only review

In a Codex session, call `dispatch_wait` with an explicit executor id:

~~~json
{
  "to": "claude-opus",
  "task": {
    "prompt": "Review the current diff for correctness, regressions, and missing tests. Report only actionable findings."
  },
  "request_id": "review-current-diff-opus-1",
  "timeout_ms": 120000
}
~~~

For the Fable-backed Claude agent:

~~~json
{
  "to": "claude-fable",
  "task": {
    "prompt": "Independently review the current diff. Focus on security and reliability risks."
  },
  "request_id": "review-current-diff-fable-1",
  "timeout_ms": 120000
}
~~~

If `claude` is missing, not on `PATH`, unauthenticated, or its named local agent is unavailable, the job reaches a clear failed state with the CLI error. The relay never installs Claude, changes global settings, or creates credentials.

## MCP tools and job lifecycle

### Submit now, retrieve later

`dispatch` creates (or deduplicates) a durable job and returns immediately:

~~~json
// dispatch
{
  "to": "codex",
  "task": { "prompt": "Review the current diff for correctness." },
  "request_id": "review-current-diff-codex-1"
}

// response
{ "job_id": "relay-…", "deduped": false, "state": "queued" }
~~~

Call `poll` until it reaches a terminal state:

~~~json
// poll
{ "job_id": "relay-…" }

// response
{
  "found": true,
  "state": "completed",
  "result": { "text": "…" },
  "attempts": 1
}
~~~

The same `request_id` returns the same job rather than scheduling the work twice.

### Submit and wait

`dispatch_wait` follows the same idempotent path but waits for a terminal result, up to `timeout_ms`:

~~~json
{
  "to": "codex",
  "task": { "prompt": "Review the current diff for correctness." },
  "request_id": "review-current-diff-codex-2",
  "timeout_ms": 120000
}
~~~

If the caller timeout expires first, the result says `timed_out: true` and reports the current queued or running state. The job continues server-side; retrieve it later with `poll`.

### Job states

| State | Meaning |
| --- | --- |
| `queued` | Waiting for a worker |
| `running` | Claimed by one worker with an active lease |
| `completed` | Durable final result available |
| `failed` | The adapter or policy rejected the job |
| `cancelled` | Cancellation was accepted |
| `needs_recovery` | A write-capable run lost its lease; it is never silently re-executed |
| `needs_review` | A human decision is required before or after execution |

## Security model

The relay assumes task prompts are untrusted data. It does not treat them as a shell request.

- The central registry owns the executable, fixed CLI arguments, and Claude agent name.
- A job can choose only an exact, known `to` id. Unknown ids fail safely.
- Claude adapters inherit a reduced environment and do not take payload environment values.
- All Claude jobs are read-only in this version. `write: true` for either Claude worker is an explicit failure before a CLI process starts.
- Codex writes are deny-by-default and require both a `write: true` job and a worker launched with `--allow-writes`.
- Write jobs with an expired lease go to `needs_recovery` instead of being replayed.
- Worktree execution is available for eligible Codex writes, so the main worktree stays untouched.
- Wake-up notifications contain only a minimal job envelope, never untrusted prompt text or model output.

This protects the relay’s command-selection boundary. It does not make a prompt harmless to the model receiving it; write careful task prompts and inspect all results.

## Running workers

Autospawn is convenient for local MCP use, but explicit workers work the same queue and are useful for long-lived or supervised setups.

~~~bash
# Claim at most one queued job, execute it, then exit.
node worker.mjs --agent codex --once

# Keep a read-only Claude worker running.
node worker.mjs --agent claude-opus --interval 1000
node worker.mjs --agent claude-fable --interval 1000

# Permit Codex write jobs (still requires task.write: true).
node worker.mjs --agent codex --allow-writes --interval 1000

# Stop after five minutes with no jobs processed.
node worker.mjs --agent codex --idle-timeout 300000
~~~

Worker selection is always based on `--agent` and the registry. It is never taken from a job payload.

### Store location

By default, state is stored beneath:

~~~text
~/.mcp-agent-relay/state
~~~

Set `RELAY_DATA_DIR` to choose another durable local location. Every process that participates in the same relay—the MCP server, workers, and optional hooks—must use the same store location.

## Codex writes in isolated worktrees

Codex is the only executor that can write in this first release. To opt in, start the Codex worker with `--allow-writes` and request an isolated worktree:

~~~json
{
  "to": "codex",
  "task": {
    "prompt": "Implement TASK-192 and add focused tests.",
    "write": true,
    "worktree": true
  },
  "request_id": "implement-task-192-1"
}
~~~

The relay creates a branch and git worktree based on the caller’s current `HEAD`. The result includes `worktree.path`, `worktree.branch`, and `worktree.baseSha` for manual review and merge. Nothing merges automatically.

If a write turn makes no change, its temporary worktree and branch are removed. If it fails after making changes, the worktree is preserved and its path is included in the error for manual recovery.

> A worktree starts from the last commit, not from uncommitted edits in the caller’s main worktree.

## Human review gate

Jobs can require a human decision rather than running or completing autonomously.

- Add a non-empty `requireReview` reason to a task to put it in `needs_review` before execution.
- An executor can self-flag an ambiguous or sensitive task with `RELAY_NEEDS_REVIEW: <reason>` in the final response; its partial result is retained for inspection.
- Resolve gates only from the local review CLI, never through MCP tools:

~~~bash
node bin/relay-review.mjs list
node bin/relay-review.mjs approve <jobId> --by "reviewer" --note "approved after inspection"
node bin/relay-review.mjs reject <jobId> --by "reviewer" --note "not safe to run"
~~~

Predeclared approval returns a job to `queued` so it can run. Approval of a self-flagged result accepts that captured result. Rejection marks the job `failed`.

The CLI gate prevents a normal MCP client from approving its own job through the tools it already holds. It is not a complete process-isolation boundary: a local process with shell access can invoke the review CLI. Stronger approval authority requires a separate credential or isolation boundary.

## Claude Code integration

The relay can be used from Claude Code either as a plugin or as a plain MCP server.

### Plugin install

~~~bash
claude plugin marketplace add <your-org>/mcp-agent-relay
claude plugin install mcp-agent-relay
~~~

The plugin declares `agentrelay` in [`.mcp.json`](.mcp.json) and includes relay slash commands. The supplied commands dispatch to `codex`:

- `/mcp-agent-relay:review <path> [focus]` requests a read-only Codex review.
- `/mcp-agent-relay:implement <task>` requests an isolated Codex worktree run; it needs a Codex worker allowed to write.

### Plain Claude MCP install

~~~bash
claude mcp add --scope user agentrelay \
  node /absolute/path/to/mcp-agent-relay/server.mjs \
  -e RELAY_AGENT=claude-main \
  -e RELAY_WORKER_AUTOSPAWN=1 \
  -e RELAY_WORKER_AGENTS=codex,claude-opus,claude-fable
~~~

Plugin and plain-server installations expose different MCP names:

| Installation | Tool prefix | Channel source |
| --- | --- | --- |
| Plugin | `mcp__plugin_mcp-agent-relay_agentrelay__` | `plugin:mcp-agent-relay@mcp-agent-relay` |
| Plain `claude mcp add` | `mcp__agentrelay__` | `server:agentrelay` |

### Optional wake-up channel

Set a logical `RELAY_AGENT` identity on the Claude session and launch it with its corresponding development channel:

~~~bash
# Plugin installation
RELAY_AGENT=claude-main claude \
  --dangerously-load-development-channels plugin:mcp-agent-relay@mcp-agent-relay

# Plain MCP installation
RELAY_AGENT=claude-main claude \
  --dangerously-load-development-channels server:agentrelay
~~~

The channel sends only a small `job_id` and `state` notification. Claude then uses `poll` to obtain the normal structured result. When `CLAUDE_CODE_SESSION_ID` is available, notifications are narrowed to the specific session that dispatched the job.

### Stop hook alternative

The channel is optional. A Stop hook checks the store as Claude is about to end a turn and gives it one more turn to poll a newly completed job:

~~~bash
# Add project settings. Use --global for ~/.claude/settings.json.
node bin/relay-install-hook.mjs
~~~

The helper is idempotent. Use `--print` to preview or `--remove` to undo it. The hook needs the same `RELAY_AGENT` and `RELAY_DATA_DIR` configuration as the MCP server. It fails open, so an internal hook error never blocks a Claude session from ending.

## Requirements and limitations

- Node.js **18.18 or newer**. The runtime has no npm dependencies.
- The `codex` worker needs the Codex CLI available on its `PATH`.
- Claude workers need an existing local, authenticated Claude Code CLI plus the allowlisted agent definitions. The relay does not provision either.
- Claude jobs are read-only only. There is no Claude write mode in this release.
- The store is a local file-backed queue coordinated by an interprocess lock. It is designed for one machine, not a multi-host queue.
- The development channel is a Claude Code preview feature and may require the explicit channel flag. The queue, polling, and Stop hook remain usable without it.

## Development

~~~bash
node --test
~~~

The suite covers the store and MCP facade, worker lifecycle, review and worktree protections, Codex compatibility, executor-registry resolution, and mocked Claude CLI success, failure, cancellation, and payload-isolation behavior.

## License

[MIT](LICENSE)
