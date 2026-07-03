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
  needsReview,
  getJob,
  inboxFor,
  coercePayload,
  TERMINAL_STATES
} from "./relay-jobs.mjs";
import { codexExecRunTurn } from "./codex-executor.mjs";
import { withWorktreeIsolation } from "./worktree-runner.mjs";

// Re-exported so callers/tests that reach for it via the worker keep working.
export { coercePayload };

const TERMINAL = new Set(TERMINAL_STATES);

export const DEFAULT_LEASE_MS = 120_000; // generous: turns can be silent for a while
export const DEFAULT_HEARTBEAT_MS = 30_000; // renew well before the lease expires
export const DEFAULT_POLL_MS = 500;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_ABORT_GRACE_MS = 2000; // extra wait for an abort-aware executor to clean up
export const DEFAULT_WORKER_INTERVAL_MS = 1000;

// --- human-review gate (needs_review) -----------------------------------------
//
// Two independent paths lead a job into needs_review:
//   - PREDECLARED (reliable): the dispatcher sets payload.requireReview="<motive>".
//     A non-empty string is a HARD gate — the turn never runs until a human approves.
//   - SELF-FLAGGED (best-effort/advisory): every prompt gets REVIEW_POSTSCRIPT appended,
//     inviting the model to end its answer with a `RELAY_NEEDS_REVIEW: <motive>` line
//     when the task is too ambiguous / touches money or production. parseReviewMarker
//     detects that line after the turn. This is advisory: predeclared is the real control.

export const REVIEW_MARKER = "RELAY_NEEDS_REVIEW";

// Appended to EVERY prompt (not opt-in). Kept short and explicit so the model only emits
// the marker when it genuinely needs a human, and always as the very last line.
export const REVIEW_POSTSCRIPT = [
  "---",
  "Antes de considerar esta tarefa concluída: se ela for ambígua demais para finalizar",
  "com segurança de forma autônoma, ou se envolver dinheiro, credenciais ou ambiente de",
  "produção de um jeito que exija validação humana antes de concluir, então — e SOMENTE",
  "então — a ÚLTIMA linha da sua resposta, depois de toda a saída pedida, deve ser",
  "exatamente:",
  `${REVIEW_MARKER}: <motivo breve>`,
  "Caso contrário, não escreva nada sobre revisão."
].join("\n");

// Append the review postscript to a prompt. Exported for isolated testing.
export function withReviewPostscript(prompt) {
  return `${prompt}\n\n${REVIEW_POSTSCRIPT}`;
}

// Tolerate common markdown lead-ins/trailers around the marker: bold/italic/list/quote/
// backtick/whitespace. Matches e.g. "**RELAY_NEEDS_REVIEW:** buy prod creds",
// "- relay_needs_review: ...", "`RELAY_NEEDS_REVIEW`: ...".
const REVIEW_MARKER_RE = /^[\s>*_`-]*relay_needs_review[\s*_`]*:\s*(.*)$/i;

// Motives that really mean "no review needed" — treat as if the marker were absent so a
// model that dutifully writes "RELAY_NEEDS_REVIEW: none" does not deadlock on a human.
const REVIEW_NEGATIVES = new Set([
  "none",
  "n/a",
  "na",
  "no",
  "nope",
  "not needed",
  "not required",
  "nenhum",
  "nenhuma",
  "não",
  "nao",
  "-"
]);

// Scan the LAST `scanLines` non-empty lines of a turn's output for an affirmative review
// marker (not anywhere in the text). Returns { needsReview, reason, output } where output
// has the matched marker line stripped — the motive lives only in riskReason, never
// duplicated inside the stored output. Exported for isolated testing.
export function parseReviewMarker(output, { scanLines = 3, maxReasonLen = 300 } = {}) {
  if (typeof output !== "string" || !output) {
    return { needsReview: false, reason: null, output };
  }
  const lines = output.split("\n");
  // Indices of the last `scanLines` NON-EMPTY lines (trailing blank lines ignored).
  const candidates = [];
  for (let i = lines.length - 1; i >= 0 && candidates.length < scanLines; i--) {
    if (lines[i].trim() !== "") candidates.push(i);
  }
  for (const idx of candidates) {
    const m = lines[idx].match(REVIEW_MARKER_RE);
    if (!m) continue;
    // Strip markdown emphasis that can wrap the motive (e.g. "**RELAY_NEEDS_REVIEW:** foo"
    // leaves "** foo" in the capture) from both ends.
    let reason = (m[1] ?? "").trim().replace(/^[*_`]+/, "").replace(/[*_`]+$/, "").trim();
    const negativeKey = reason.toLowerCase().replace(/[.!]+$/, "").trim();
    if (reason === "" || REVIEW_NEGATIVES.has(negativeKey)) {
      // Explicit "no review" — route as if unmarked, but still strip the noise line.
      lines.splice(idx, 1);
      return { needsReview: false, reason: null, output: lines.join("\n").replace(/\s+$/, "") };
    }
    if (reason.length > maxReasonLen) reason = reason.slice(0, maxReasonLen);
    lines.splice(idx, 1);
    return { needsReview: true, reason, output: lines.join("\n").replace(/\s+$/, "") };
  }
  return { needsReview: false, reason: null, output };
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
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

const defaultRunTurn = withWorktreeIsolation(codexExecRunTurn);

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
  const payload = coercePayload(job.payload);
  if (!payload || typeof payload.prompt !== "string" || !payload.prompt) {
    const fr = fail(cwd, job.id, claimToken, "payload sem 'prompt'");
    if (!fr.ok) return { outcome: "lost", job: getJob(cwd, job.id) };
    return { outcome: "failed", reason: "no_prompt", job: getJob(cwd, job.id) };
  }
  const write = payload.write === true;
  const worktree = payload.worktree === true;
  if (write && !allowWrites) {
    const fr = fail(cwd, job.id, claimToken, "escrita não permitida (allowWrites=false)");
    if (!fr.ok) return { outcome: "lost", job: getJob(cwd, job.id) };
    return { outcome: "failed", reason: "write_denied", job: getJob(cwd, job.id) };
  }

  // Human-review gate (PREDECLARED). A non-empty payload.requireReview string is a HARD
  // gate: short-circuit BEFORE startRunning/runTurn so the turn never runs until a human
  // approves. reviewClearedForRun (set by resolveReview on approval) lets an approved job
  // skip this on its NEXT claim — without it the requeued job would loop back into the
  // same short-circuit forever. Runs after the no-prompt/write-denied checks so a job that
  // could not run anyway fails fast instead of parking for a review it would never reach.
  if (typeof payload.requireReview === "string" && payload.requireReview.trim() && !job.reviewClearedForRun) {
    const nr = needsReview(cwd, job.id, claimToken, {
      reason: payload.requireReview.trim(),
      reviewKind: "predeclared",
      result: null
    });
    if (!nr.ok) return { outcome: "lost", job: getJob(cwd, job.id) };
    return { outcome: "needs_review_predeclared", job: getJob(cwd, job.id) };
  }

  // Only run the turn if we actually still own the claim. If it expired between
  // claim() and here (and was requeued/parked/cancelled), do NOT run — that would
  // be a side effect outside our possession.
  const started = startRunning(cwd, job.id, claimToken);
  if (!started.ok) {
    return { outcome: "lost", job: getJob(cwd, job.id) };
  }
  // Renew lease immediately — the original claim lease may be near expiry before
  // the first setInterval tick fires. If this fails the claim was stolen in the
  // window between startRunning and here; abort before starting runTurn.
  const immediateHb = heartbeat(cwd, job.id, claimToken, leaseMs);
  if (!immediateHb.ok) {
    return { outcome: "lost", job: getJob(cwd, job.id) };
  }

  // An external signal (worker shutdown / SIGINT) aborts the in-flight turn too.
  // abortHandler is stored so it can be removed after runTurn settles — otherwise
  // long-lived workers accumulate stale listeners on the outer signal (one per job).
  let abortHandler = null;
  if (signal) {
    if (signal.aborted) {
      controller.abort("external");
    } else {
      abortHandler = () => controller.abort("external");
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  // Heartbeat by timer; also the cooperative-cancel detector.
  const hb = setInterval(() => {
    const cur = getJob(cwd, job.id);
    if (!jobIsOurs(cur, claimToken)) {
      controller.abort("cancelled-or-stolen");
      return;
    }
    const hbr = heartbeat(cwd, job.id, claimToken, leaseMs);
    if (!hbr.ok) controller.abort("heartbeat-failed");
  }, heartbeatMs);

  let result;
  let threw;
  try {
    result = await runTurn(cwd, {
      prompt: withReviewPostscript(payload.prompt),
      model: payload.model,
      effort: payload.effort,
      write,
      worktree,
      jobId: job.id,
      onProgress: () => {},
      signal: controller.signal
    });
  } catch (err) {
    threw = err;
  } finally {
    clearInterval(hb);
    if (abortHandler) signal.removeEventListener("abort", abortHandler);
  }

  // On a successful turn, scan the tail of the output for a SELF-FLAGGED review marker.
  // cleanedOutput has the marker line stripped (identical to result.output when unmarked),
  // so the motive is carried only in riskReason and is never duplicated inside the output.
  let selfFlagged = false;
  let reviewReason = null;
  let cleanedOutput = result?.output;
  if (result?.ok === true) {
    const parsed = parseReviewMarker(result.output);
    selfFlagged = parsed.needsReview;
    reviewReason = parsed.reason;
    cleanedOutput = parsed.output;
  }

  // Decide based on the CURRENT store state — a cancel/steal wins over our result.
  const cur = getJob(cwd, job.id);
  if (!jobIsOurs(cur, claimToken)) {
    return { outcome: "lost", job: cur };
  }
  if (controller.signal.aborted) {
    // Aborted by an external timeout (cancel would have made it "not ours").
    if (write) {
      const msg = result?.worktree
        ? `abortado por timeout (write) — needs_recovery (worktree preservada: path=${result.worktree.path} branch=${result.worktree.branch})`
        : "abortado por timeout (write) — needs_recovery";
      const settled = park(cwd, job.id, claimToken, msg);
      if (!settled.ok) return { outcome: "lost", job: getJob(cwd, job.id) };
      return { outcome: "timeout_parked", job: getJob(cwd, job.id) };
    }
    const settled = release(cwd, job.id, claimToken); // read-only: safe to requeue
    if (!settled.ok) return { outcome: "lost", job: getJob(cwd, job.id) };
    return { outcome: "timeout_requeued", job: getJob(cwd, job.id) };
  }
  if (threw) {
    const settled = fail(cwd, job.id, claimToken, threw?.message ?? String(threw));
    if (!settled.ok) return { outcome: "lost", job: getJob(cwd, job.id) };
    return { outcome: "failed", job: getJob(cwd, job.id) };
  }
  // SELF-FLAGGED review (best-effort/advisory): the model asked for a human gate on its
  // OWN completed output. Park it in needs_review with the partial result (worktree
  // pointer preserved when present, so the human can inspect the isolated tree) instead
  // of completing. The reliable control is the predeclared requireReview gate above.
  if (result?.ok && selfFlagged) {
    const nr = needsReview(cwd, job.id, claimToken, {
      reason: reviewReason,
      reviewKind: "selfflagged",
      result: {
        output: cleanedOutput,
        threadId: result.threadId,
        touchedFiles: result.touchedFiles,
        ...(result.worktree ? { worktree: result.worktree } : {})
      }
    });
    if (!nr.ok) return { outcome: "lost", job: getJob(cwd, job.id) };
    return { outcome: "needs_review_selfflagged", job: getJob(cwd, job.id) };
  }
  if (result?.ok) {
    const settled = complete(cwd, job.id, claimToken, {
      output: cleanedOutput,
      threadId: result.threadId,
      touchedFiles: result.touchedFiles,
      ...(result.worktree ? { worktree: result.worktree } : {})
    });
    if (!settled.ok) return { outcome: "lost", job: getJob(cwd, job.id) };
    return { outcome: "completed", job: getJob(cwd, job.id) };
  }
  const errorMessage = result?.worktree
    ? `${result?.error ?? "turn failed"} (worktree preservada: path=${result.worktree.path} branch=${result.worktree.branch})`
    : (result?.error ?? "turn failed");
  const settled = fail(cwd, job.id, claimToken, errorMessage);
  if (!settled.ok) return { outcome: "lost", job: getJob(cwd, job.id) };
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
  const inbox = inboxFor(cwd, agentId, { limit: 5 });
  for (const candidate of inbox) {
    const claimed = claim(cwd, candidate.id, workerId, leaseMs);
    if (claimed) {
      return processJob(cwd, claimed.job, claimed.claimToken, { runTurn, leaseMs, heartbeatMs, allowWrites, signal });
    }
  }
  return null;
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
  const payload = coercePayload(task);
  const write = Boolean(payload && payload.write === true);
  const enqueued = enqueue(cwd, {
    requestId,
    to,
    payload,
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
    // If processJob is still running (non-abortable runTurn), force-settle the job
    // so the orphaned heartbeat stops renewing the lease on the next tick.
    // Guard on our claimToken: if processJob already settled, the store no longer
    // carries our token, making park/release a safe no-op (fenced by claimToken).
    const afterCeiling = getJob(cwd, enqueued.jobId);
    if (
      afterCeiling &&
      !TERMINAL.has(afterCeiling.relayState) &&
      afterCeiling.claim?.claimToken === claimed.claimToken
    ) {
      const settled = write
        ? park(cwd, enqueued.jobId, claimed.claimToken, "timeout — needs_recovery (executor non-abortable)")
        : release(cwd, enqueued.jobId, claimed.claimToken);
      // settled.ok === false means another mutation raced us between getJob() and here;
      // the store is in a consistent current state — getJob() below reads the truth.
      void settled;
    }
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
// provided AbortSignal aborts, or when idleTimeoutMs elapses with no jobs processed.
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
    idleTimeoutMs = null,
    signal
  } = {}
) {
  let idleDeadline = null;
  while (!signal?.aborted) {
    // Honor the idle deadline before draining: once it passes, stop without
    // processing a job that arrived after we were already due to exit.
    if (idleDeadline != null && Date.now() >= idleDeadline) break;

    const processed = await drainOnce(cwd, { agentId, workerId, leaseMs, heartbeatMs, runTurn, allowWrites, signal });
    if (processed) {
      idleDeadline = null;
    } else {
      let sleepMs = intervalMs;
      if (idleTimeoutMs != null) {
        const now = Date.now();
        if (idleDeadline == null) idleDeadline = now + idleTimeoutMs;
        const remainingIdleMs = idleDeadline - now;
        if (remainingIdleMs <= 0) break;
        // Never sleep past the idle deadline, even when intervalMs is larger.
        sleepMs = Math.min(intervalMs, remainingIdleMs);
      }
      await sleep(sleepMs, signal);
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
