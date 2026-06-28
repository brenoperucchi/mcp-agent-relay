# Plan v4 — invisible worker (auto-spawned daemon) + `claude-relay` launcher

> Goal: the "normal user" experience. After `plugin install`, a user dispatches a job and it
> **executes without them ever running `node worker.mjs`**; they wake their session hands-free by
> launching with one wrapper command instead of a long flag string.
>
> Ergonomics layer on the working v0.1 relay (store + facade + worker + channel). **No new
> durability guarantees** — durable store, single-flight claim, leases, channel are unchanged. It
> changes *who starts the worker* and *how the session launches*, and fixes two pre-existing
> correctness gaps it would otherwise expose (write-job lease policy in `dispatch`; bounded abort).
>
> **History:** Codex adversarial plan review → `needs_rework` (10 changes) → v2 closed 7 →
> re-review `needs_rework` (CR-1/3/10 open + 2 new) → v3 closed NEW-1/CR-3/CR-5/CR-10 → 3rd
> re-review `needs_rework` (CR-1 in-lock wait; adopt-vs-cleanup race) → **this v4** makes
> `isAliveAndOurs` single-read synchronous and resolves the race by CAS-ing both transitions on
> `(token, status="starting")` under the lock. The core insight across reviews: the relay lock is
> a **synchronous busy-wait**, so it must **never be held across an async await** (it would freeze
> the event loop / block other processes ~5 s); every locked section here is short and synchronous.

## Unavoidable vs. hideable

| Piece | Needed for hands-free? | Hideable? |
|---|---|---|
| A worker alive to execute | yes | **yes** → auto-spawned daemon |
| The session launch flag (channel) | yes (preview, solo) | **no** for solo → launcher; only org `allowedChannelPlugins` removes it |

---

## Deliverable 0 — extract the proven lock `[CR-1]`

`relay-jobs.mjs` has a battle-tested interprocess lock (`withLock`, atomic-rename steal, nonce,
`DEFAULT_LOCK_TIMEOUT_MS=5000` busy-wait, `DEFAULT_LOCK_STALE_MS=30000`), module-private and
hard-wired to the store lock file. Extract behavior-preserving:
- new `lib/file-lock.mjs` → `withFileLock(lockFile, fn, { lockTimeoutMs, lockStaleMs })`, **fn stays
  synchronous** (the lock is a sync busy-wait; `fn` must not await),
- `relay-jobs.mjs` keeps `withLock(cwd, fn, opts) = withFileLock(relayLockFile(cwd), fn, opts)`.
- **Acceptance:** the 16 relay-jobs tests pass unchanged.

Because `fn` is synchronous, the lifecycle (D1) is built so **every locked section is sync and
short**; the async readiness wait happens *outside* any lock `[CR-1][NEW-2]`.

---

## Deliverable 1 — `lib/worker-lifecycle.mjs` (the daemon)

### State — `resolveStateDir(cwd)/worker-<safeAgent>.json` `[CR-6]`
`<safeAgent>` validated `/^[A-Za-z0-9_.-]{1,64}$/` (channel-style sanitizer); else rejected before
any path is built.
```json
{ "pid": 12345, "token": "a1b2…", "status": "starting|running",
  "agent": "codex", "allowWrites": false, "intervalMs": 1000,
  "heartbeatFile": "…/worker-codex-a1b2….heartbeat",   // token-scoped: no old/new collision
  "logFile": "…/worker-codex.log", "startedAt": "<iso>" }
```
Heartbeat file is **token-scoped** so a departing daemon and its replacement never write the same
file `[CR-2]`.

### Heartbeat record (written by the worker, D2): `{ pid, token, ts }`, atomic (temp+rename).

### Liveness `isAliveAndOurs(state)` — **purely synchronous, single read** `[CR-2][CR-4]`
All of: `process.kill(pid,0)` ≠ `ESRCH` (`EPERM`⇒alive); heartbeat exists, `token`+`pid` match;
`now - ts < STALE_MS`, with `STALE_MS = max(3×intervalMs, LOCK_TIMEOUT_MS + slack)` (≈15 s, > the
5 s lock freeze). **No waiting/re-read** — one synchronous read, so it is safe inside a locked
critical section `[CR-1]`. A live worker briefly frozen by lock contention resumes within
`LOCK_TIMEOUT_MS` (5 s) ≪ `STALE_MS` (15 s), so a single read never false-negatives in practice.
Used for the **reuse**/adopt decision (non-destructive: a false "alive" only delays a respawn
until `STALE_MS`, jobs wait, recoverable). The two-sample **advance** check lives only in the
async `provenLiveAndOurs` (below), which runs **outside** any lock.

### Identity proof for **signaling** `provenLiveAndOurs(state)` `[CR-3]`
Stronger than liveness, required before SIGTERM-ing a pid from *state* (not from a handle we own):
sample `ts`, wait ~`intervalMs`, sample again — require the heartbeat `ts` to **advance** (a dead
worker's heartbeat is frozen even if still "fresh"; a recycled PID isn't writing our token-scoped
file). No advancement ⇒ not provably ours ⇒ **do not signal**, just unlink.

### `ensureWorkerSession(cwd, { agent, allowWrites, intervalMs, timeoutMs, scriptPath, env })`
**In-process debounce `[CR-9]`** first: `Map<agent, Promise>` — if an ensure is in flight for the
agent in this process, return it (serializes same-process; prevents re-entering the sync lock).

**Phase 1 — short SYNC critical section** under `withFileLock(worker-<safeAgent>.lock, …)`:
1. read state.
2. `isAliveAndOurs(state)` **and** `state.status==="running"`:
   - `state.allowWrites === allowWrites` → **reuse** (return it).
   - else config mismatch → **refuse + log** (do not spawn a second; the durable job waits until
     the user stops the daemon to change write capability) `[CR-5]`. return the existing state.
3. `state.status==="starting"` and `startedAt` **fresh** (< `STARTING_STALE_MS = timeoutMs +
   ABORT_GRACE_MS + slack`) → another starter still owns it (and, if it times out, has time to
   finish its kill+cleanup before this window elapses) → return `{status:"starting"}`, no spawn `[CR-1]`.
4. `status==="starting"` but **stale** (≥ `STARTING_STALE_MS`) → abandoned starter. **CAS under
   this same lock** on `(token, status==="starting")`: if `isAliveAndOurs(state)` (sync) → the
   child came up but its starter died → **adopt**: set `status:"running"` and return it; else →
   unlink and fall through to spawn (5). Because the original starter's timeout cleanup (Phase 2)
   *also* CAS-es on `status==="starting"` under this lock, only one of {adopt, original-cleanup}
   wins — the loser observes the flipped status and backs off `[race-fix]`.
5. else (no/dead/stale): unlink stale state files (no signaling here — sync section), mint
   `token`, `spawn` detached+unref `node worker.mjs --agent a --interval N [--allow-writes]
   --heartbeat-file <token-scoped> --worker-token <token>` (returns immediately), **retain the
   `ChildProcess` handle**, write state `{pid, token, status:"starting", startedAt:now, …}` (atomic).

**Phase 2 — readiness OUTSIDE any lock (async)** `[CR-1][NEW-2]`:
- reuse/starting/refuse decisions returned already.
- for a fresh spawn: `await` up to `timeoutMs` for a fresh heartbeat with matching `token`.
  - ready → short locked **CAS**: if `state.token===token && state.status==="starting"` → set
    `status:"running"`, return state; else (adopted/replaced) → relinquish the handle, return the
    current state (someone else owns it now).
  - timeout → **decide under the lock first** (CAS), *then* kill: short locked section — if
    `state.token===token && state.status==="starting"` → unlink state, set `intent=kill`; else
    (a stale-starting adopter already flipped it to `running`, or it was replaced) → `intent=relinquish`.
    Only if `intent===kill`: **kill the retained `ChildProcess` handle's process group**
    (`process.kill(-child.pid,…)`, SIGTERM→grace→SIGKILL) and `await` exit `[NEW-1]`. If
    `intent===relinquish`: drop the handle without killing (the worker is live and adopted). return `null`.
    Deciding *before* killing is the fix for the adopt-vs-cleanup race: once either side removes/flips
    the `starting` state under the lock, the other cannot act on the same child `[race-fix]`.

### `stopWorker(cwd, agent)` / `teardownWorkerSession`
Explicit stop: `provenLiveAndOurs` → SIGTERM the process group (the worker's SIGTERM handler aborts
its turn, bounded by D4) → grace → SIGKILL → unlink. Not proven ⇒ unlink only `[CR-3]`. Idempotent.

### Optional idle self-exit `RELAY_WORKER_IDLE_MS` (default off) `[CR-opt-1]`.

---

## Deliverable 2 — heartbeat in `worker.mjs` (CLI-only) `[CR-2]`

Reviewed loop (`lib/relay-worker.mjs`) **untouched**. CLI adds `--heartbeat-file` + `--worker-token`:
write `{pid, token, ts}` atomically (temp+rename) once at startup then every `intervalMs`;
`clearInterval`+`unref` on SIGINT/SIGTERM. Carried caveat: the timer shares the thread with the
sync lock busy-wait, so a write can lag up to `LOCK_TIMEOUT_MS` — which is exactly what `STALE_MS`
sizing absorbs `[CR-4]`.

---

## Deliverable 3 — `dispatch` in `server.mjs`

**3a. Write-job lease policy `[CR-7]` (prerequisite correctness fix):** `dispatch`'s `enqueue`
omits `leaseExpiryPolicy` (defaults `"requeue"`), so a write job whose lease expires would
auto-rerun. Pass `leaseExpiryPolicy: args.task?.write === true ? "park" : "requeue"`.

**3b. Gated/restricted/isolated auto-spawn `[CR-6][CR-9]`:** after a successful enqueue, *maybe*
`ensureWorkerSession`:
- only when `RELAY_WORKER_AUTOSPAWN` set (`.mcp.json` sets `"1"`; unset elsewhere ⇒ the 63 tests
  spawn nothing `[CR-gate]`),
- only if `to` ∈ `RELAY_WORKER_AGENTS` (default `["codex"]`) — logical agents are woken by the
  channel, never auto-executed `[CR-6]`,
- via `setImmediate`, always `.catch(logErr)`, per-agent in-process debounce `[CR-9]`,
- `allowWrites` only when `RELAY_WORKER_ALLOW_WRITES` set (deny-by-default).

---

## Deliverable 4 — bounded abort in `lib/codex-executor.mjs` `[CR-8]`

Spawn `detached: true` (own process group; **not** `unref` — we await `close`). On abort:
`process.kill(-child.pid, "SIGTERM")` (whole group, catches codex's children); after
`ABORT_GRACE_MS` (2 s) `process.kill(-child.pid, "SIGKILL")`; clear the timer on `close`; the
returned promise settles within grace even if codex ignores SIGTERM. Bounds the worker's
timeout/cancel path end-to-end.

---

## Deliverable 5 — `bin/claude-relay`
```sh
#!/usr/bin/env bash
exec env RELAY_AGENT="${RELAY_AGENT:-claude-main}" \
  claude --dangerously-load-development-channels server:relay "$@"
```
README documents it (server-name `relay`; marketplace install namespaces it). `.cmd` shim is a
Windows follow-up `[CR-opt-3]`.

---

## End-user path
```
claude plugin install mcp-agent-relay     # relay auto-registered (.mcp.json, AUTOSPAWN=1)
claude-relay                              # session WITH channel (one word)
  └─ dispatch(to:"codex", task)           # durable enqueue (write→park lease)
       └─ setImmediate ensureWorkerSession("codex")   ← daemon born once, under short lock
            └─ worker claims → codex exec (group-killable) → complete (durable)
                 └─ channel wakes Claude → poll → acts   ← hands-free, no /loop
```

---

## Tests (`node --test`, temp dirs, fake fixtures) `[CR-10]`
1. **ensure spawns** (fake worker heartbeats with the token) → state persisted, token matches, `status:"running"`.
2. **reuse-if-alive+ours** → same pid, nothing spawned.
3. **config mismatch** `[CR-5]`: live `allowWrites=false`, ensure `true` → **refuse**, no second spawn, log emitted.
4. **stale heartbeat** `[CR-4]`: old `ts` → after one-interval re-read → dead → respawn.
5. **identity guard / PID-reuse (signal path)** `[CR-3]`: state pid → an **unrelated live process** (real `sleep`) with a **frozen-but-fresh** token-matching heartbeat → `stopWorker`/teardown observes non-advancing `ts` → **does NOT signal** (assert the sleep survives) → unlinks state.
6. **readiness timeout** `[NEW-1]`: fake worker that never heartbeats → ensure kills it **via the retained handle's group**, returns `null`, state not persisted.
7. **concurrent ensure, two processes** `[CR-1]`: two child processes ensure the same agent at once → exactly **one** daemon; the loser sees `"starting"` and returns **fast** (assert it is **not** blocked ≈`LOCK_TIMEOUT_MS`) `[NEW-2]`.
8. **heartbeat atomicity** `[CR-2]`: concurrent writers/readers → never a partial read.
9. **bounded abort** `[CR-8]`: fake `codex` on PATH ignoring SIGTERM → executor escalates to SIGKILL; turn settles `< grace + margin`, group gone.
10. **autospawn gate** `[CR-gate]`: `RELAY_WORKER_AUTOSPAWN` unset → dispatch spawns nothing; non-allowlisted `to` → nothing `[CR-6]`.
11. **lock extraction** `[CR-1]`: the 16 relay-jobs tests pass unchanged after `file-lock.mjs`.
12. **abandoned starter + adopt/cleanup CAS** `[race-fix]`: stale `status:"starting"` with a live+ours child → **adopted** (flip to running, no second spawn); stale with a dead pid → respawn. Race assertion: a simulated original-starter timeout-cleanup and an adopter contend under the lock → exactly one wins, the child is **either** adopted-and-running **or** killed-and-respawned, never killed-after-adopt.

Fixtures use real detached processes + fake worker/`codex` scripts (no real `codex`).

---

## Out of scope
Central reaper (gated idle-exit stands in); removing the flag for solo users (org allowlist only);
multi-machine workers; Windows-native daemon / `.cmd` shim.

## Risks → mitigations (post two reviews)
| Risk | Mitigation |
|---|---|
| Two callers spawn two daemons | per-agent lifecycle lock; `"starting"` claim; re-check under lock `[CR-1]` |
| Lock held across async freezes loop / blocks peers ~5 s | lock wraps short **sync** sections only (`isAliveAndOurs` is single-read sync); readiness awaits outside it `[CR-1][NEW-2]` |
| Adopt-vs-cleanup race (kill after adopt) | both transitions **CAS on `(token, status="starting")`** under the lock; kill decided *before* killing; `STARTING_STALE_MS` covers kill grace `[race-fix]` |
| Old/new daemon heartbeat collision | token-scoped heartbeat files `[CR-2]` |
| Teardown kills recycled PID | signal only when heartbeat `ts` **advances** (proven ours); own spawns killed via handle `[CR-3][NEW-1]` |
| False stale teardown | `STALE_MS > LOCK_TIMEOUT_MS`; suspect→wait→re-read `[CR-4]` |
| Surprise write privilege on reuse | config mismatch → **refuse + log**, never silent reuse `[CR-5]` |
| Auto-spawn arbitrary/unsafe `to` | allowlist + filename-safe sanitize `[CR-6]` |
| Write job auto-reruns on lease expiry | `dispatch` passes `"park"` for writes `[CR-7]` |
| Codex orphaned / hangs on abort | process-group kill + SIGKILL escalation within grace `[CR-8]` |
| Dispatch latency / unhandled rejection | `setImmediate` + `.catch` + per-agent debounce `[CR-9]` |
| Tests overclaim | rewritten to adversarial cases incl. fast-loser & frozen-heartbeat `[CR-10]` |
