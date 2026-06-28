// relay-worker.mjs — execution side of the MCP transport.
//
// Drives queued relay jobs to completion. This is DELIBERATELY separate from the
// MCP coordination facade (server.mjs): coordination (enqueue/poll) must
// not be coupled to execution (running Codex, which can write files). Only this
// module runs turns.
//
// Safety (from Codex's adversarial review of the plan):
//   - Heartbeat by TIMER (not model progress) keeps the lease alive during a
//     silent turn, so the job is not requeued and re-run while a worker is alive.
//   - Writes are DENIED by default; a write job only runs with allowWrites=true.
//   - A write job whose lease expires is PARKED (needs_recovery), never auto re-run.
//   - dispatchAndWait is single-flight: it claims-or-polls; it never runs a turn
//     for a job another worker already owns.
//   - A wait timeout ABORTS the turn (no orphan): read-only → back to queued,
//     write → parked.
//   - Cancellation is cooperative: cancelling the job makes the heartbeat tick
//     abort the turn.
//
// runTurn is INJECTABLE so tests drive the lifecycle without a real Codex binary.

import { fileURLToPath } from "node:url";

import {
  enqueue,
  claim,
  startRunning,
  heartbeat,
  complete,
  fail,
  release,
  park,
  getJob,
  inboxFor,
  TERMINAL_STATES
} from "./relay-jobs.mjs";
import { codexExecRunTurn } from "./codex-executor.mjs";

const TERMINAL = new Set(TERMINAL_STATES);

export const DEFAULT_LEASE_MS = 120_000; // generous: turns can be silent for a while
export const DEFAULT_HEARTBEAT_MS = 30_000; // renew well before the lease expires
export const DEFAULT_POLL_MS = 500;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_ABORT_GRACE_MS = 2000; // extra wait for an abort-aware executor to clean up
export const DEFAULT_WORKER_INTERVAL_MS = 1000;

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

// A sleep whose timer can be cancelled, so a bounded wait does not leak a timer.
function cancelableSleep(ms) {
  let cancel = () => {};
  const promise = new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    cancel = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  return { promise, cancel };
}

const defaultRunTurn = codexExecRunTurn;

function jobIsOurs(cur, claimToken) {
  return Boolean(
    cur &&
      (cur.relayState === "running" || cur.relayState === "claimed") &&
      cur.claim?.claimToken === claimToken
  );
}

// Run a claimed job to a terminal state. Returns { outcome, job }.
export async function processJob(
  cwd,
  job,
  claimToken,
  {
    runTurn = defaultRunTurn,
    leaseMs = DEFAULT_LEASE_MS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    allowWrites = false,
    controller = new AbortController(),
    signal
  } = {}
) {
  const payload = job.payload;
  if (!payload || typeof payload.prompt !== "string" || !payload.prompt) {
    fail(cwd, job.id, claimToken, "payload sem 'prompt'");
    return { outcome: "failed", reason: "no_prompt", job: getJob(cwd, job.id) };
  }
  const write = payload.write === true;
  if (write && !allowWrites) {
    fail(cwd, job.id, claimToken, "escrita não permitida (allowWrites=false)");
    return { outcome: "failed", reason: "write_denied", job: getJob(cwd, job.id) };
  }

  // Only run the turn if we actually still own the claim. If it expired between
  // claim() and here (and was requeued/parked/cancelled), do NOT run — that would
  // be a side effect outside our possession.
  const started = startRunning(cwd, job.id, claimToken);
  if (!started.ok) {
    return { outcome: "lost", job: getJob(cwd, job.id) };
  }

  // An external signal (worker shutdown / SIGINT) aborts the in-flight turn too.
  if (signal) {
    if (signal.aborted) {
      controller.abort("external");
    } else {
      signal.addEventListener("abort", () => controller.abort("external"), { once: true });
    }
  }

  // Heartbeat by timer; also the cooperative-cancel detector.
  const hb = setInterval(() => {
    const cur = getJob(cwd, job.id);
    if (!jobIsOurs(cur, claimToken)) {
      controller.abort("cancelled-or-stolen");
      return;
    }
    heartbeat(cwd, job.id, claimToken, leaseMs);
  }, heartbeatMs);

  let result;
  let threw;
  try {
    result = await runTurn(cwd, {
      prompt: payload.prompt,
      model: payload.model,
      effort: payload.effort,
      write,
      onProgress: () => {},
      signal: controller.signal
    });
  } catch (err) {
    threw = err;
  } finally {
    clearInterval(hb);
  }

  // Decide based on the CURRENT store state — a cancel/steal wins over our result.
  const cur = getJob(cwd, job.id);
  if (!jobIsOurs(cur, claimToken)) {
    return { outcome: "lost", job: cur };
  }
  if (controller.signal.aborted) {
    // Aborted by an external timeout (cancel would have made it "not ours").
    if (write) {
      park(cwd, job.id, claimToken, "abortado por timeout (write) — needs_recovery");
      return { outcome: "timeout_parked", job: getJob(cwd, job.id) };
    }
    release(cwd, job.id, claimToken); // read-only: safe to requeue
    return { outcome: "timeout_requeued", job: getJob(cwd, job.id) };
  }
  if (threw) {
    fail(cwd, job.id, claimToken, threw?.message ?? String(threw));
    return { outcome: "failed", job: getJob(cwd, job.id) };
  }
  if (result?.ok) {
    complete(cwd, job.id, claimToken, {
      output: result.output,
      threadId: result.threadId,
      touchedFiles: result.touchedFiles
    });
    return { outcome: "completed", job: getJob(cwd, job.id) };
  }
  fail(cwd, job.id, claimToken, result?.error ?? "turn failed");
  return { outcome: "failed", job: getJob(cwd, job.id) };
}

// Claim and process the next queued job for an agent. Returns null if there is
// nothing to do or another worker won the claim (single-flight).
export async function drainOnce(
  cwd,
  {
    agentId = "codex",
    workerId = "worker",
    leaseMs = DEFAULT_LEASE_MS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    runTurn = defaultRunTurn,
    allowWrites = false,
    signal
  } = {}
) {
  const inbox = inboxFor(cwd, agentId, { limit: 1 });
  if (!inbox.length) {
    return null;
  }
  const claimed = claim(cwd, inbox[0].id, workerId, leaseMs);
  if (!claimed) {
    return null; // lost the race
  }
  return processJob(cwd, claimed.job, claimed.claimToken, { runTurn, leaseMs, heartbeatMs, allowWrites, signal });
}

function summarize(jobId, job, deduped, timedOut) {
  return {
    jobId,
    deduped: Boolean(deduped),
    timedOut: Boolean(timedOut),
    state: job?.relayState ?? "unknown",
    result: job?.result ?? null,
    error: job?.errorMessage ?? null
  };
}

// Synchronous convenience: enqueue and wait for the result. Single-flight (claims
// or polls), aborts on timeout (no orphan), writes the durable result before
// returning. NOT exposed on the coordination facade (execution stays separate).
export async function dispatchAndWait(
  cwd,
  {
    requestId,
    to,
    task,
    ttlMs = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    leaseMs = DEFAULT_LEASE_MS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    pollMs = DEFAULT_POLL_MS,
    abortGraceMs = DEFAULT_ABORT_GRACE_MS,
    runTurn = defaultRunTurn,
    allowWrites = false,
    workerId = "dispatcher"
  } = {}
) {
  const write = Boolean(task && task.write === true);
  const enqueued = enqueue(cwd, {
    requestId,
    to,
    payload: task,
    ttlMs,
    leaseExpiryPolicy: write ? "park" : "requeue"
  });

  // Already finished (dedup of a prior run): return immediately.
  if (TERMINAL.has(enqueued.job.relayState)) {
    return summarize(enqueued.jobId, enqueued.job, enqueued.deduped, false);
  }

  // Single-flight: own it, or observe it.
  const claimed = claim(cwd, enqueued.jobId, workerId, leaseMs);
  if (claimed) {
    let timedOut = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort("timeout");
    }, timeoutMs);
    // processJob settles itself durably; detach so a non-abortable executor still
    // running in the background never produces an unhandled rejection.
    const jobDone = processJob(cwd, claimed.job, claimed.claimToken, {
      runTurn,
      leaseMs,
      heartbeatMs,
      allowWrites,
      controller
    }).catch(() => {});
    // Bound the wait: an abort-aware executor finishes shortly after the abort; a
    // non-abortable one is capped by (timeout + grace) and left running durably.
    const ceiling = cancelableSleep(timeoutMs + abortGraceMs);
    await Promise.race([jobDone, ceiling.promise]);
    ceiling.cancel();
    clearTimeout(timer);
    const job = getJob(cwd, enqueued.jobId);
    return summarize(enqueued.jobId, job, enqueued.deduped, timedOut);
  }

  // Another worker owns it: poll until terminal or timeout (never run it ourselves).
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = getJob(cwd, enqueued.jobId);
    if (job && TERMINAL.has(job.relayState)) {
      return summarize(enqueued.jobId, job, enqueued.deduped, false);
    }
    if (Date.now() >= deadline) {
      return summarize(enqueued.jobId, job, enqueued.deduped, true);
    }
    await sleep(pollMs);
  }
}

// Continuous worker for ASYNC jobs (which otherwise never execute). Stops when the
// provided AbortSignal aborts.
export async function runWorkerLoop(
  cwd,
  {
    agentId = "codex",
    workerId = "worker",
    intervalMs = DEFAULT_WORKER_INTERVAL_MS,
    runTurn = defaultRunTurn,
    allowWrites = false,
    leaseMs = DEFAULT_LEASE_MS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    signal
  } = {}
) {
  while (!signal?.aborted) {
    const processed = await drainOnce(cwd, { agentId, workerId, leaseMs, heartbeatMs, runTurn, allowWrites, signal });
    if (!processed) {
      await sleep(intervalMs, signal);
    }
  }
}

export const __isEntrypoint = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();
