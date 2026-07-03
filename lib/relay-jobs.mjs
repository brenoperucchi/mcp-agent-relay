// relay-jobs.mjs — Durable job-relay for the MCP transport layer.
//
// A single-machine, multi-process, file-backed job queue with request_id dedup
// and a safe claim/lease lifecycle. This is the durability core the MCP facade
// (the MCP facade) and the worker build on.
//
// WHY A SEPARATE STORE (not a generic app state.json):
//   The companion's state.jobs[] is NOT durable enough for a relay (Codex review,
//   verdict: repensar): the MAX_JOBS=50 cap would prune in-flight relay jobs, there
//   is no lock (double-claim), the write is non-atomic (a crash mid-write corrupts
//   state.json and loadState silently returns []), and dedup dies on prune. So the
//   relay keeps its OWN file (relay-state.json) and reuses only the SAFE helpers
//   from store-paths.mjs: workspace state-dir resolution, id generation, and the per-job
//   event-file location.
//
// DURABILITY / SAFETY GUARANTEES:
//   - Atomic persistence: temp file → fsync → rename (+ best-effort dir fsync).
//     Reads do NOT rewrite the store unless the sweep actually changed something.
//   - Corrupt store is a HARD, LOUD error: loadStore throws on every call and does
//     NOT silently fall back to an empty queue. Recovery is explicit via resetStore.
//   - Interprocess lock (lockfile) with an ownership nonce: a stale lock is stolen
//     via an atomic rename (only one process wins), and release is conditional
//     (a process only removes the lock if it is still the owner), so a process can
//     never delete another process's lock.
//   - Fencing token per claim: complete/fail only succeed with the CURRENT claim's
//     token, so a worker whose lease expired cannot clobber a reassigned job.
//   - Sweep-on-access: every public API runs the sweep first (under the lock), so
//     lease/TTL expiry happens without depending on an external timer.
//   - Dedup index is DERIVED from jobs (rebuilt on every load), so it can never
//     diverge from the job list.
//
// KNOWN LIMITATION (future hardening): the lock does not renew its mtime while held,
//   so a holder paused longer than lockStaleMs could be stolen from (a brief
//   double-writer window). lockStaleMs is generous (30s) relative to these
//   millisecond-scale ops; OS advisory locks / mtime renewal are a later phase.
//
// JOB STATE MACHINE:
//   queued → claimed → running → (completed | failed)
//   claimed|running → queued        (release, or lease expiry → requeue)
//   claimed|running → needs_review  (human gate: predeclared at claimed, self-flagged
//                                    at running); resolveReview → queued (predeclared
//                                    approve) | completed (selfflagged approve) | failed
//   any non-terminal → cancelled    (control action)
//   non-terminal past TTL → expired
//   Terminal: completed, failed, cancelled, expired, needs_recovery, needs_review.
//   Prunable subset (time/hard-cap eviction): completed, failed, cancelled, expired.
//   needs_recovery / needs_review are terminal but NEVER auto-pruned — they wait on an
//   explicit operator decision (recover / resolveReview) before entering retention.
//
// DEDUP CONTRACT (honest): dedup by request_id holds while the job is RETAINED in
//   the store (active, or terminal within the retention window). After retention,
//   the index entry is pruned and a re-enqueue creates a new job.

import fs from "node:fs";
import path from "node:path";

import { resolveStateDir, generateJobId, resolveJobEventFile } from "./store-paths.mjs";
import { withFileLock } from "./file-lock.mjs";

const STORE_VERSION = 1;
const STORE_FILE_NAME = "relay-state.json";
const LOCK_FILE_NAME = "relay-state.lock";

export const RELAY_STATES = Object.freeze([
  "queued",
  "claimed",
  "running",
  "completed",
  "failed",
  "cancelled",
  "expired",
  "needs_recovery",
  "needs_review"
]);
export const TERMINAL_STATES = Object.freeze([
  "completed",
  "failed",
  "cancelled",
  "expired",
  "needs_recovery",
  "needs_review"
]);
const TERMINAL = new Set(TERMINAL_STATES);

// A settled job is "terminal", but only the PRUNABLE subset is eligible for time-based
// retention drops AND hard-cap eviction. needs_recovery and needs_review are
// terminal-but-NOT-prunable: they hold work waiting on an explicit human/operator
// decision (recover / resolveReview) and must never disappear silently — not after the
// retention window, not under the hard cap. Resolving one restamps terminalAtMs into a
// prunable state, re-entering normal retention from the moment of resolution.
export const PRUNABLE_TERMINAL_STATES = Object.freeze(["completed", "failed", "cancelled", "expired"]);
const PRUNABLE = new Set(PRUNABLE_TERMINAL_STATES);

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_MAX_JOBS = 500;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000; // keep terminal jobs 24h for dedup/result
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_LOCK_STALE_MS = 30000;

export class RelayStoreError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = "RelayStoreError";
    this.code = code ?? "RELAY_STORE_ERROR";
  }
}

// Tolerate a payload that arrived JSON-encoded as a STRING. Some MCP clients (LLMs in
// particular) serialize an object argument before sending it; without this, a task dispatched
// as `"{\"prompt\":\"…\"}"` would lose its fields. Only coerce a string that parses to a plain
// OBJECT (not an array/number/null) — anything else is returned untouched so validation and
// write-policy detection downstream behave predictably. Coerce at the dispatch entry point so
// write-detection / leaseExpiryPolicy are computed from the real object, not the raw string.
export function coercePayload(payload) {
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      /* not JSON — leave as-is */
    }
  }
  return payload;
}

function nowMs(clock) {
  return typeof clock === "function" ? clock() : Date.now();
}

function defaultStore() {
  return { version: STORE_VERSION, jobs: [], index: {}, agents: {} };
}

// The index is DERIVED from jobs (jobs are the source of truth), so it can never
// diverge: a parseable-but-inconsistent file is normalized on load.
function rebuildIndex(store) {
  const index = {};
  for (const job of store.jobs) {
    if (job && job.requestId) {
      index[job.requestId] = job.id;
    }
  }
  store.index = index;
  return store;
}

function normalizeStore(parsed) {
  const store = {
    version: STORE_VERSION,
    jobs: Array.isArray(parsed?.jobs) ? parsed.jobs.filter((job) => job && job.id) : [],
    index: {},
    agents: parsed?.agents && typeof parsed.agents === "object" ? { ...parsed.agents } : {}
  };
  return rebuildIndex(store);
}

function relayStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STORE_FILE_NAME);
}

function relayLockFile(cwd) {
  return path.join(resolveStateDir(cwd), LOCK_FILE_NAME);
}

function ensureRelayDir(cwd) {
  fs.mkdirSync(resolveStateDir(cwd), { recursive: true });
}

// --- durable persistence -------------------------------------------------

function loadStore(cwd) {
  const file = relayStateFile(cwd);
  if (!fs.existsSync(file)) {
    return defaultStore();
  }
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new RelayStoreError(`não foi possível ler ${file}: ${err.message}`, { code: "READ_FAILED" });
  }
  try {
    return normalizeStore(JSON.parse(raw));
  } catch {
    // Corrupt store: fail loudly on EVERY call (the file is left intact for
    // inspection) until an operator calls resetStore(). Never silently empty.
    throw new RelayStoreError(
      `relay-state.json corrompido (${file}). Chame resetStore(cwd) para arquivar e recomeçar.`,
      { code: "CORRUPT_STORE" }
    );
  }
}

function persistStore(cwd, store) {
  ensureRelayDir(cwd);
  const file = relayStateFile(cwd);
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${STORE_FILE_NAME}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const data = `${JSON.stringify({ version: STORE_VERSION, jobs: store.jobs, index: store.index, agents: store.agents ?? {} }, null, 2)}\n`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  // Best-effort directory fsync so the rename itself is durable.
  try {
    const dfd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {
    // Directory fsync is not supported everywhere; ignore.
  }
}

// Explicit recovery from a corrupt store. Archives the bad file and starts fresh.
export function resetStore(cwd, { archive = true } = {}) {
  return withLock(cwd, () => {
    const file = relayStateFile(cwd);
    if (archive && fs.existsSync(file)) {
      try {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      } catch {
        // If we cannot archive it, persistStore below overwrites it anyway.
      }
    }
    persistStore(cwd, defaultStore());
    return { ok: true };
  });
}

// --- interprocess lock (shared implementation in file-lock.mjs) ---

// The lock primitive lives in file-lock.mjs so the worker daemon lifecycle can reuse the
// SAME proven implementation on its own per-agent lock file. This wrapper keeps the
// store's lock keyed to relayLockFile(cwd) and preserves the RelayStoreError/LOCK_TIMEOUT
// contract callers already rely on.
function withLock(cwd, fn, { lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS, lockStaleMs = DEFAULT_LOCK_STALE_MS } = {}) {
  ensureRelayDir(cwd);
  return withFileLock(relayLockFile(cwd), fn, {
    lockTimeoutMs,
    lockStaleMs,
    makeTimeoutError: (message) => new RelayStoreError(message, { code: "LOCK_TIMEOUT" })
  });
}

// --- sweep (lease/TTL/retention), runs on every access -------------------

function sweepStore(store, now, { retentionMs = DEFAULT_RETENTION_MS, maxJobs = DEFAULT_MAX_JOBS } = {}) {
  const events = [];
  for (const job of store.jobs) {
    if (TERMINAL.has(job.relayState)) {
      continue;
    }
    // Job TTL (measured from enqueue) takes precedence over lease handling.
    if (job.ttlMs != null && now - job.enqueuedAtMs > job.ttlMs) {
      const running = job.relayState === "claimed" || job.relayState === "running";
      if (running && job.leaseExpiryPolicy === "park") {
        // A write job still in flight may have partially written — preserve the
        // recovery signal instead of a plain "expired".
        job.relayState = "needs_recovery";
        job.errorMessage = "TTL expirado em job park em execução — requer recover()";
        events.push({ jobId: job.id, type: "relay_needs_recovery" });
      } else {
        job.relayState = "expired";
        events.push({ jobId: job.id, type: "relay_expired" });
      }
      job.terminalAtMs = now;
      job.updatedAtMs = now;
      job.claim = null;
      continue;
    }
    // Lease expiry.
    if (
      (job.relayState === "claimed" || job.relayState === "running") &&
      job.claim &&
      job.claim.leaseExpiresAtMs != null &&
      now > job.claim.leaseExpiresAtMs
    ) {
      job.claim = null;
      job.updatedAtMs = now;
      if (job.leaseExpiryPolicy === "park") {
        // Write/side-effecting job whose owner may have died mid-run: never
        // auto re-run; park for explicit recovery.
        job.relayState = "needs_recovery";
        job.errorMessage = "lease expirada (job park) — requer recover() explícito";
        job.terminalAtMs = now;
        events.push({ jobId: job.id, type: "relay_needs_recovery" });
      } else {
        job.attempts += 1;
        if (job.attempts >= job.maxAttempts) {
          job.relayState = "failed";
          job.errorMessage = "lease expirado após o número máximo de tentativas";
          job.terminalAtMs = now;
          events.push({ jobId: job.id, type: "relay_failed" });
        } else {
          job.relayState = "queued";
          events.push({ jobId: job.id, type: "relay_requeued" });
        }
      }
    }
  }
  const prunedCount = pruneStore(store, now, { retentionMs, maxJobs });
  return { events, changed: events.length > 0 || prunedCount > 0 };
}

function pruneStore(store, now, { retentionMs, maxJobs }) {
  const before = store.jobs.length;
  // 1. Drop PRUNABLE terminal jobs older than the retention window (dedup window ends
  //    here). needs_recovery / needs_review are terminal but NOT prunable: they are
  //    kept regardless of age until an operator resolves them (which restamps
  //    terminalAtMs into a prunable state and re-enters this window).
  let retained = store.jobs.filter((job) => {
    if (!PRUNABLE.has(job.relayState)) {
      return true;
    }
    return job.terminalAtMs != null && now - job.terminalAtMs <= retentionMs;
  });
  // 2. Hard cap: if still over the limit, drop the oldest PRUNABLE terminal jobs first.
  //    Active work AND jobs awaiting human action (needs_review / needs_recovery) are
  //    never dropped — if only those remain above the cap the store is allowed to grow
  //    rather than silently discard a job a human still needs to see.
  if (retained.length > maxJobs) {
    const prunable = retained
      .filter((job) => PRUNABLE.has(job.relayState))
      .sort((a, b) => (a.terminalAtMs ?? 0) - (b.terminalAtMs ?? 0));
    const overflow = retained.length - maxJobs;
    const toDrop = new Set(prunable.slice(0, overflow).map((job) => job.id));
    retained = retained.filter((job) => !toDrop.has(job.id));
  }
  store.jobs = retained;
  rebuildIndex(store);
  return before - store.jobs.length;
}

// --- event log (per-job event file via store-paths.mjs) ---------------------

function emitEvents(cwd, events, now) {
  for (const ev of events) {
    try {
      const file = resolveJobEventFile(cwd, ev.jobId);
      fs.appendFileSync(file, `${JSON.stringify({ t: new Date(now).toISOString(), ...ev })}\n`, "utf8");
    } catch {
      // Best-effort, matching event-stream.mjs semantics.
    }
  }
}

// --- mutate / read wrapper -----------------------------------------------

// Runs fn under the lock with sweep-on-access. Persists ONLY when something
// actually changed (sweep transitions/prune, or a mutating fn), so pure reads
// do not rewrite the store.
function withStore(cwd, fn, opts = {}) {
  const now = nowMs(opts.clock);
  return withLock(
    cwd,
    () => {
      const store = loadStore(cwd);
      const sweep = sweepStore(store, now, opts);
      const out = fn(store, now) ?? {};
      const events = [...sweep.events, ...(out.events ?? [])];
      if (sweep.changed || out.changed) {
        persistStore(cwd, store);
      }
      if (events.length) {
        emitEvents(cwd, events, now);
      }
      return out.result;
    },
    opts
  );
}

function findJob(store, jobId) {
  return store.jobs.find((job) => job.id === jobId) ?? null;
}

function snapshot(job) {
  return job ? JSON.parse(JSON.stringify(job)) : null;
}

// --- public API ----------------------------------------------------------

export function enqueue(
  cwd,
  { requestId, to = null, from = null, payload = null, ttlMs = null, maxAttempts, leaseExpiryPolicy = "requeue" } = {},
  opts = {}
) {
  if (!requestId) {
    throw new RelayStoreError("enqueue requer um requestId (chave de idempotência)", { code: "MISSING_REQUEST_ID" });
  }
  return withStore(
    cwd,
    (store, now) => {
      const existingId = store.index[requestId];
      if (existingId) {
        const existing = findJob(store, existingId);
        if (existing) {
          return { result: { jobId: existing.id, deduped: true, job: snapshot(existing) }, changed: false };
        }
      }
      const id = generateJobId("relay");
      const job = {
        id,
        requestId,
        relayState: "queued",
        to,
        from,
        payload,
        enqueuedAtMs: now,
        updatedAtMs: now,
        terminalAtMs: null,
        ttlMs: ttlMs ?? null,
        maxAttempts: maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        // On lease expiry: "requeue" (safe, read-only) or "park" → needs_recovery
        // (for side-effecting/write jobs that must NOT auto re-run).
        leaseExpiryPolicy: leaseExpiryPolicy === "park" ? "park" : "requeue",
        attempts: 0,
        claim: null,
        completedByToken: null,
        result: null,
        errorMessage: null,
        // Human-review gate (needs_review). riskReason: the motive shown to the human.
        // reviewKind: "predeclared" (gated before running) | "selfflagged" (model asked
        // mid-turn). reviewClearedForRun: set true by resolveReview when an operator
        // approves a predeclared job, so the worker skips the pre-run gate on the next
        // claim (otherwise the approved job requeues and loops back into the gate).
        riskReason: null,
        reviewKind: null,
        reviewResolvedBy: null,
        reviewResolvedAtMs: null,
        reviewClearedForRun: false,
        reviewNote: null
      };
      store.jobs.push(job);
      store.index[requestId] = id;
      return {
        result: { jobId: id, deduped: false, job: snapshot(job) },
        events: [{ jobId: id, type: "relay_enqueued", to }],
        changed: true
      };
    },
    opts
  );
}

export function claim(cwd, jobId, workerId, leaseMs = null, opts = {}) {
  return withStore(
    cwd,
    (store, now) => {
      const job = findJob(store, jobId);
      if (!job || job.relayState !== "queued") {
        return { result: null, changed: false };
      }
      const claimToken = generateJobId("claim");
      job.relayState = "claimed";
      job.claim = {
        workerId: workerId ?? null,
        claimToken,
        claimedAtMs: now,
        leaseExpiresAtMs: leaseMs != null ? now + leaseMs : null
      };
      job.updatedAtMs = now;
      return {
        result: { job: snapshot(job), claimToken },
        events: [{ jobId: job.id, type: "relay_claimed", workerId: workerId ?? null }],
        changed: true
      };
    },
    opts
  );
}

export function startRunning(cwd, jobId, claimToken, opts = {}) {
  return withStore(
    cwd,
    (store, now) => {
      const job = findJob(store, jobId);
      if (!job || job.relayState !== "claimed" || !job.claim || job.claim.claimToken !== claimToken) {
        return { result: { ok: false, job: snapshot(job) }, changed: false };
      }
      job.relayState = "running";
      job.updatedAtMs = now;
      return {
        result: { ok: true, job: snapshot(job) },
        events: [{ jobId: job.id, type: "relay_running" }],
        changed: true
      };
    },
    opts
  );
}

export function heartbeat(cwd, jobId, claimToken, leaseMs, opts = {}) {
  return withStore(
    cwd,
    (store, now) => {
      const job = findJob(store, jobId);
      if (
        !job ||
        (job.relayState !== "claimed" && job.relayState !== "running") ||
        !job.claim ||
        job.claim.claimToken !== claimToken
      ) {
        return { result: { ok: false, job: snapshot(job) }, changed: false };
      }
      job.claim.leaseExpiresAtMs = leaseMs != null ? now + leaseMs : null;
      job.updatedAtMs = now;
      return { result: { ok: true, job: snapshot(job) }, changed: true };
    },
    opts
  );
}

export function release(cwd, jobId, claimToken, opts = {}) {
  return withStore(
    cwd,
    (store, now) => {
      const job = findJob(store, jobId);
      if (
        !job ||
        (job.relayState !== "claimed" && job.relayState !== "running") ||
        !job.claim ||
        job.claim.claimToken !== claimToken
      ) {
        return { result: { ok: false, job: snapshot(job) }, changed: false };
      }
      job.relayState = "queued";
      job.claim = null;
      job.updatedAtMs = now;
      return {
        result: { ok: true, job: snapshot(job) },
        events: [{ jobId: job.id, type: "relay_released" }],
        changed: true
      };
    },
    opts
  );
}

export function complete(cwd, jobId, claimToken, result = null, opts = {}) {
  return withStore(
    cwd,
    (store, now) => {
      const job = findJob(store, jobId);
      if (!job) {
        return { result: { ok: false, reason: "not_found", job: null }, changed: false };
      }
      // Idempotent: re-completing with the same token returns the cached result.
      if (job.relayState === "completed" && job.completedByToken === claimToken) {
        return { result: { ok: true, job: snapshot(job) }, changed: false };
      }
      if (TERMINAL.has(job.relayState)) {
        return { result: { ok: false, reason: "already_terminal", job: snapshot(job) }, changed: false };
      }
      if (job.relayState !== "claimed" && job.relayState !== "running") {
        return { result: { ok: false, reason: "not_claimed", job: snapshot(job) }, changed: false };
      }
      // Fencing: a stale worker (expired lease, job reassigned) cannot complete.
      if (!job.claim || job.claim.claimToken !== claimToken) {
        return { result: { ok: false, reason: "stale_claim_token", job: snapshot(job) }, changed: false };
      }
      job.relayState = "completed";
      job.result = result;
      job.completedByToken = claimToken;
      job.terminalAtMs = now;
      job.claim = null;
      job.updatedAtMs = now;
      return {
        result: { ok: true, job: snapshot(job) },
        events: [{ jobId: job.id, type: "relay_completed" }],
        changed: true
      };
    },
    opts
  );
}

export function fail(cwd, jobId, claimToken, errorMessage = null, { retry = false, ...opts } = {}) {
  return withStore(
    cwd,
    (store, now) => {
      const job = findJob(store, jobId);
      if (!job) {
        return { result: { ok: false, reason: "not_found", job: null }, changed: false };
      }
      if (TERMINAL.has(job.relayState)) {
        return { result: { ok: false, reason: "already_terminal", job: snapshot(job) }, changed: false };
      }
      if (job.relayState !== "claimed" && job.relayState !== "running") {
        return { result: { ok: false, reason: "not_claimed", job: snapshot(job) }, changed: false };
      }
      if (!job.claim || job.claim.claimToken !== claimToken) {
        return { result: { ok: false, reason: "stale_claim_token", job: snapshot(job) }, changed: false };
      }
      job.attempts += 1;
      job.claim = null;
      job.updatedAtMs = now;
      if (retry && job.attempts < job.maxAttempts) {
        job.relayState = "queued";
        return {
          result: { ok: true, job: snapshot(job) },
          events: [{ jobId: job.id, type: "relay_requeued" }],
          changed: true
        };
      }
      job.relayState = "failed";
      job.errorMessage = errorMessage;
      job.terminalAtMs = now;
      return {
        result: { ok: true, job: snapshot(job) },
        events: [{ jobId: job.id, type: "relay_failed" }],
        changed: true
      };
    },
    opts
  );
}

export function cancel(cwd, jobId, opts = {}) {
  return withStore(
    cwd,
    (store, now) => {
      const job = findJob(store, jobId);
      if (!job) {
        return { result: { ok: false, reason: "not_found", job: null }, changed: false };
      }
      if (TERMINAL.has(job.relayState)) {
        return { result: { ok: false, reason: "already_terminal", job: snapshot(job) }, changed: false };
      }
      job.relayState = "cancelled";
      job.claim = null;
      job.terminalAtMs = now;
      job.updatedAtMs = now;
      return {
        result: { ok: true, job: snapshot(job) },
        events: [{ jobId: job.id, type: "relay_cancelled" }],
        changed: true
      };
    },
    opts
  );
}

// Park a running job for explicit recovery (used when a write job is aborted by
// a timeout): never auto re-run. Fenced by the current claim token.
export function park(cwd, jobId, claimToken, errorMessage = null, opts = {}) {
  return withStore(
    cwd,
    (store, now) => {
      const job = findJob(store, jobId);
      if (!job) {
        return { result: { ok: false, reason: "not_found", job: null }, changed: false };
      }
      if (TERMINAL.has(job.relayState)) {
        return { result: { ok: false, reason: "already_terminal", job: snapshot(job) }, changed: false };
      }
      if (job.relayState !== "claimed" && job.relayState !== "running") {
        return { result: { ok: false, reason: "not_claimed", job: snapshot(job) }, changed: false };
      }
      if (!job.claim || job.claim.claimToken !== claimToken) {
        return { result: { ok: false, reason: "stale_claim_token", job: snapshot(job) }, changed: false };
      }
      job.relayState = "needs_recovery";
      job.errorMessage = errorMessage ?? "parked para recuperação explícita";
      job.terminalAtMs = now;
      job.claim = null;
      job.updatedAtMs = now;
      return {
        result: { ok: true, job: snapshot(job) },
        events: [{ jobId: job.id, type: "relay_needs_recovery" }],
        changed: true
      };
    },
    opts
  );
}

// Explicitly move a needs_recovery job back to queued (a human/operator decision).
export function recover(cwd, jobId, opts = {}) {
  return withStore(
    cwd,
    (store, now) => {
      const job = findJob(store, jobId);
      if (!job || job.relayState !== "needs_recovery") {
        return { result: { ok: false, job: snapshot(job) }, changed: false };
      }
      job.relayState = "queued";
      job.claim = null;
      job.terminalAtMs = null;
      job.errorMessage = null;
      job.attempts = 0;
      job.updatedAtMs = now;
      return {
        result: { ok: true, job: snapshot(job) },
        events: [{ jobId: job.id, type: "relay_recovered" }],
        changed: true
      };
    },
    opts
  );
}

// Move a claimed/running job into needs_review — a human gate. Two entry points, both
// fenced by the current claim token (same shape as park()):
//   - reviewKind "predeclared": fired at "claimed" (before startRunning) when the
//     dispatcher pre-declared that the job requires review; result is null.
//   - reviewKind "selfflagged": fired at "running" (after the turn) when the model
//     itself asked for review; result carries the partial output the human reviews
//     ({ output, threadId, touchedFiles, worktree? }).
export function needsReview(cwd, jobId, claimToken, { reason = null, reviewKind, result = null } = {}, opts = {}) {
  return withStore(
    cwd,
    (store, now) => {
      const job = findJob(store, jobId);
      if (!job) {
        return { result: { ok: false, reason: "not_found", job: null }, changed: false };
      }
      if (TERMINAL.has(job.relayState)) {
        return { result: { ok: false, reason: "already_terminal", job: snapshot(job) }, changed: false };
      }
      if (reviewKind !== "predeclared" && reviewKind !== "selfflagged") {
        return { result: { ok: false, reason: "invalid_review_kind", job: snapshot(job) }, changed: false };
      }
      if (job.relayState !== "claimed" && job.relayState !== "running") {
        return { result: { ok: false, reason: "not_claimed", job: snapshot(job) }, changed: false };
      }
      // Cross-check: predeclared only fires before the turn runs (claimed); selfflagged
      // only after it did (running). A mismatch (typo'd/corrupted reviewKind riding on
      // the "right" relayState for the OTHER kind) must not be allowed through — it is
      // exactly the semantic bug this gate exists to prevent (see resolveReview above).
      if (
        (reviewKind === "predeclared" && job.relayState !== "claimed") ||
        (reviewKind === "selfflagged" && job.relayState !== "running")
      ) {
        return { result: { ok: false, reason: "review_kind_state_mismatch", job: snapshot(job) }, changed: false };
      }
      // Fencing: only the current claim owner can move the job into review.
      if (!job.claim || job.claim.claimToken !== claimToken) {
        return { result: { ok: false, reason: "stale_claim_token", job: snapshot(job) }, changed: false };
      }
      job.relayState = "needs_review";
      job.riskReason = reason;
      job.reviewKind = reviewKind;
      job.result = result;
      job.terminalAtMs = now;
      job.claim = null;
      job.updatedAtMs = now;
      return {
        result: { ok: true, job: snapshot(job) },
        events: [{ jobId: job.id, type: "relay_needs_review" }],
        changed: true
      };
    },
    opts
  );
}

// Resolve a needs_review job — an operator/human decision, so (like cancel/recover) it
// is NOT fenced by a claim token. Guarded to needs_review only; anything else returns a
// structured error (never throws). Approval branches by how the job entered review:
//   - selfflagged + approve  → completed (keeps the already-captured result)
//   - selfflagged + reject   → failed
//   - predeclared + approve  → queued (attempts reset, reviewClearedForRun=true so the
//                              worker skips the pre-run gate on the next claim); the job
//                              becomes non-terminal again (terminalAtMs cleared)
//   - predeclared + reject   → failed
// Any terminal resolution (completed/failed) restamps terminalAtMs = now, restarting the
// retention window from the moment of resolution (not from entry into needs_review).
export function resolveReview(cwd, jobId, { approve, note = null, resolvedBy = null } = {}, opts = {}) {
  return withStore(
    cwd,
    (store, now) => {
      const job = findJob(store, jobId);
      if (!job || job.relayState !== "needs_review") {
        return {
          result: { ok: false, reason: job ? "not_needs_review" : "not_found", job: snapshot(job) },
          changed: false
        };
      }
      job.reviewResolvedBy = resolvedBy;
      job.reviewResolvedAtMs = now;
      job.reviewNote = note;
      job.updatedAtMs = now;
      if (approve === true) {
        if (job.reviewKind === "predeclared") {
          // Approved to RUN: back to the queue, non-terminal again. reviewClearedForRun
          // lets the worker bypass the pre-run gate so it does not loop back here.
          job.relayState = "queued";
          job.attempts = 0;
          job.claim = null;
          job.reviewClearedForRun = true;
          job.terminalAtMs = null;
          job.errorMessage = null;
        } else if (job.reviewKind === "selfflagged") {
          // selfflagged: accept the output the model already produced.
          job.relayState = "completed";
          job.terminalAtMs = now;
        } else {
          // Defense in depth: needsReview() already rejects invalid reviewKind values
          // before a job can reach needs_review, so this should never trigger in normal
          // use — but a corrupted/typo'd reviewKind must NEVER silently fall through to
          // "completed" (a job that never ran).
          return { result: { ok: false, reason: "invalid_review_kind", job: snapshot(job) }, changed: false };
        }
      } else {
        // Anything that is not an explicit approve rejects (fail-safe gate).
        job.relayState = "failed";
        job.errorMessage = note ?? "rejeitado na revisão humana";
        job.terminalAtMs = now;
      }
      return {
        result: { ok: true, job: snapshot(job) },
        events: [{ jobId: job.id, type: "relay_review_resolved", approve: approve === true }],
        changed: true
      };
    },
    opts
  );
}

export function getJob(cwd, jobId, opts = {}) {
  return withStore(cwd, (store) => ({ result: snapshot(findJob(store, jobId)), changed: false }), opts);
}

export function findByRequestId(cwd, requestId, opts = {}) {
  return withStore(
    cwd,
    (store) => {
      const id = store.index[requestId];
      return { result: id ? snapshot(findJob(store, id)) : null, changed: false };
    },
    opts
  );
}

export function list(cwd, opts = {}) {
  return withStore(cwd, (store) => ({ result: store.jobs.map(snapshot), changed: false }), opts);
}

// --- agent registry (powers the MCP facade's inbox resources) ------------

// Persisting registered agents makes an agent's inbox discoverable BEFORE any
// job is addressed to it (avoids a subscribe/dispatch race in the facade).
export function registerAgent(cwd, agentId, opts = {}) {
  if (!agentId) {
    throw new RelayStoreError("registerAgent requer um agentId", { code: "MISSING_AGENT_ID" });
  }
  return withStore(
    cwd,
    (store, now) => {
      if (!store.agents) {
        store.agents = {};
      }
      const existing = store.agents[agentId];
      store.agents[agentId] = {
        registeredAt: existing?.registeredAt ?? now,
        lastSeen: now
      };
      return {
        result: { agentId, inboxUri: `relay://inbox/${encodeURIComponent(agentId)}`, ...store.agents[agentId] },
        changed: true
      };
    },
    opts
  );
}

export function listAgents(cwd, opts = {}) {
  return withStore(
    cwd,
    (store) => ({
      result: Object.entries(store.agents ?? {}).map(([agentId, meta]) => ({ agentId, ...meta })),
      changed: false
    }),
    opts
  );
}

// An agent's inbox: the jobs currently queued (claimable) for that agent.
export function inboxFor(cwd, agentId, { limit = 100, ...opts } = {}) {
  return withStore(
    cwd,
    (store) => ({
      result: store.jobs
        .filter((job) => job.to === agentId && job.relayState === "queued")
        .slice(0, Math.max(0, limit))
        .map(snapshot),
      changed: false
    }),
    opts
  );
}
