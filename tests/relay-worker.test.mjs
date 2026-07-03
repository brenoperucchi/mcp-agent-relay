import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as relay from "../lib/relay-jobs.mjs";
import * as worker from "../lib/relay-worker.mjs";

// Worker tests use REAL time (the heartbeat/timeout/poll timers and the relay's
// lease all run on Date.now), with short durations + generous margins.
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "relay-worker-cwd-"));

function setup() {
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "relay-worker-data-"));
  return CWD;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const okTurn = async () => ({ ok: true, output: "done", threadId: "t", touchedFiles: [] });

// A fake turn that resolves after delayMs but rejects (AbortError) if aborted.
function abortableTurn(output, delayMs) {
  return (_cwd, opts) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ ok: true, output, threadId: "t", touchedFiles: [] }), delayMs);
      const signal = opts?.signal;
      if (signal) {
        const onAbort = () => {
          clearTimeout(timer);
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
}

test("processJob roda o turno e completa o job (result durável)", async () => {
  const cwd = setup();
  const e = relay.enqueue(cwd, { requestId: "r1", to: "codex", payload: { prompt: "hi" } });
  const c = relay.claim(cwd, e.jobId, "w1", 1000);
  const r = await worker.processJob(cwd, c.job, c.claimToken, { runTurn: okTurn });
  assert.equal(r.outcome, "completed");
  const job = relay.getJob(cwd, e.jobId);
  assert.equal(job.relayState, "completed");
  assert.equal(job.result.output, "done");
});

test("payload em string JSON é tolerado (coerce) e executa", async () => {
  const cwd = setup();
  const e = relay.enqueue(cwd, { requestId: "rs", to: "codex", payload: '{"prompt":"hi"}' });
  const c = relay.claim(cwd, e.jobId, "w1", 1000);
  let gotPrompt = null;
  const r = await worker.processJob(cwd, c.job, c.claimToken, {
    runTurn: async (_cwd, opts) => {
      gotPrompt = opts.prompt;
      return { ok: true, output: "done", threadId: "t", touchedFiles: [] };
    }
  });
  assert.equal(r.outcome, "completed");
  // coerce extraiu o prompt "hi" da string JSON; o postscript de revisão é sempre anexado.
  assert.ok(gotPrompt.startsWith("hi"));
});

test("coercePayload: só string-JSON-de-objeto vira objeto; resto fica intocado", () => {
  assert.deepEqual(worker.coercePayload('{"prompt":"x"}'), { prompt: "x" });
  assert.deepEqual(worker.coercePayload({ prompt: "x" }), { prompt: "x" });
  assert.equal(worker.coercePayload("not json"), "not json");
  assert.equal(worker.coercePayload("42"), "42"); // number, not an object -> untouched
  assert.equal(worker.coercePayload("[1,2]"), "[1,2]"); // array -> not coerced
  assert.equal(worker.coercePayload("null"), "null"); // null -> not coerced
});

test("dispatchAndWait: task-string com write parka na política de lease (não requeue)", async () => {
  const cwd = setup();
  await worker.dispatchAndWait(cwd, {
    requestId: "dw-write",
    to: "codex",
    task: '{"prompt":"x","write":true}',
    allowWrites: true,
    runTurn: okTurn,
    timeoutMs: 2000
  });
  const job = relay.findByRequestId(cwd, "dw-write");
  assert.equal(job.leaseExpiryPolicy, "park");
});

test("heartbeat por timer mantém a posse viva durante turno silencioso (sweep não requeue)", async () => {
  const cwd = setup();
  const e = relay.enqueue(cwd, { requestId: "r1", to: "codex", payload: { prompt: "hi" } });
  const c = relay.claim(cwd, e.jobId, "w1", 150);
  const p = worker.processJob(cwd, c.job, c.claimToken, {
    runTurn: abortableTurn("done", 300),
    leaseMs: 150,
    heartbeatMs: 50
  });
  await sleep(220); // bem além da lease original de 150ms
  const mid = relay.getJob(cwd, e.jobId); // getJob roda o sweep
  assert.ok(["claimed", "running"].includes(mid.relayState)); // NÃO requeued — heartbeat manteve viva
  const r = await p;
  assert.equal(r.outcome, "completed");
});

test("escrita é negada por padrão (runTurn nem é chamado)", async () => {
  const cwd = setup();
  const e = relay.enqueue(cwd, { requestId: "w1", to: "codex", payload: { prompt: "x", write: true } });
  const c = relay.claim(cwd, e.jobId, "w1", 1000);
  let called = false;
  const r = await worker.processJob(cwd, c.job, c.claimToken, {
    runTurn: async () => {
      called = true;
      return { ok: true };
    },
    allowWrites: false
  });
  assert.equal(r.outcome, "failed");
  assert.equal(called, false);
  assert.equal(relay.getJob(cwd, e.jobId).relayState, "failed");
});

test("job de escrita com lease expirada vira needs_recovery (não re-roda); recover volta a queued", async () => {
  const cwd = setup();
  const e = relay.enqueue(cwd, {
    requestId: "w1",
    to: "codex",
    payload: { prompt: "x", write: true },
    leaseExpiryPolicy: "park"
  });
  const c = relay.claim(cwd, e.jobId, "w1", 60);
  relay.startRunning(cwd, e.jobId, c.claimToken);
  await sleep(120); // lease expira, sem heartbeat
  const parked = relay.getJob(cwd, e.jobId); // sweep
  assert.equal(parked.relayState, "needs_recovery");

  const rec = relay.recover(cwd, e.jobId);
  assert.equal(rec.ok, true);
  assert.equal(relay.getJob(cwd, e.jobId).relayState, "queued");
});

test("dispatchAndWait dirige inline e devolve o result", async () => {
  const cwd = setup();
  const r = await worker.dispatchAndWait(cwd, {
    requestId: "r1",
    to: "codex",
    task: { prompt: "hi" },
    runTurn: okTurn,
    timeoutMs: 2000
  });
  assert.equal(r.state, "completed");
  assert.equal(r.result.output, "done");
  assert.equal(relay.getJob(cwd, r.jobId).relayState, "completed");
});

test("dispatchAndWait deduplica: 2ª chamada devolve o result cacheado sem re-rodar", async () => {
  const cwd = setup();
  await worker.dispatchAndWait(cwd, { requestId: "r1", to: "codex", task: { prompt: "hi" }, runTurn: okTurn, timeoutMs: 2000 });
  let called = false;
  const r2 = await worker.dispatchAndWait(cwd, {
    requestId: "r1",
    to: "codex",
    task: { prompt: "hi2" },
    runTurn: async () => {
      called = true;
      return okTurn();
    },
    timeoutMs: 2000
  });
  assert.equal(r2.deduped, true);
  assert.equal(r2.state, "completed");
  assert.equal(called, false);
});

test("dispatchAndWait timeout (read-only) aborta, requeue, sem double-run", async () => {
  const cwd = setup();
  let runs = 0;
  const r = await worker.dispatchAndWait(cwd, {
    requestId: "r1",
    to: "codex",
    task: { prompt: "slow" },
    runTurn: (c, opts) => {
      runs += 1;
      return abortableTurn("late", 500)(c, opts);
    },
    timeoutMs: 100,
    leaseMs: 2000,
    heartbeatMs: 1000
  });
  assert.equal(r.timedOut, true);
  assert.equal(runs, 1);
  assert.equal(relay.getJob(cwd, r.jobId).relayState, "queued"); // não perdido
});

test("dispatchAndWait timeout (write) → needs_recovery (não re-roda)", async () => {
  const cwd = setup();
  const r = await worker.dispatchAndWait(cwd, {
    requestId: "w1",
    to: "codex",
    task: { prompt: "slow", write: true },
    runTurn: abortableTurn("late", 500),
    timeoutMs: 100,
    leaseMs: 2000,
    heartbeatMs: 1000,
    allowWrites: true
  });
  assert.equal(r.timedOut, true);
  assert.equal(relay.getJob(cwd, r.jobId).relayState, "needs_recovery");
});

test("single-flight: dois dispatchAndWait concorrentes (mesmo request_id) só rodam o turno UMA vez", async () => {
  const cwd = setup();
  let runs = 0;
  const mkRun = (c, opts) => {
    runs += 1;
    return abortableTurn("done", 150)(c, opts);
  };
  const [a, b] = await Promise.all([
    worker.dispatchAndWait(cwd, { requestId: "r1", to: "codex", task: { prompt: "x" }, runTurn: mkRun, timeoutMs: 3000, leaseMs: 2000, heartbeatMs: 500 }),
    worker.dispatchAndWait(cwd, { requestId: "r1", to: "codex", task: { prompt: "x" }, runTurn: mkRun, timeoutMs: 3000, leaseMs: 2000, heartbeatMs: 500 })
  ]);
  assert.equal(runs, 1);
  assert.equal(a.jobId, b.jobId);
  assert.equal(a.state, "completed");
  assert.equal(b.state, "completed");
});

test("cancelar um job rodando aborta o turno (cooperativo)", async () => {
  const cwd = setup();
  const e = relay.enqueue(cwd, { requestId: "r1", to: "codex", payload: { prompt: "x" } });
  const c = relay.claim(cwd, e.jobId, "w1", 2000);
  const p = worker.processJob(cwd, c.job, c.claimToken, {
    runTurn: abortableTurn("done", 400),
    leaseMs: 2000,
    heartbeatMs: 40
  });
  await sleep(80); // deixa começar
  relay.cancel(cwd, e.jobId); // cancela no meio
  const r = await p;
  assert.equal(r.outcome, "lost"); // result descartado; job cancelado vence
  assert.equal(relay.getJob(cwd, e.jobId).relayState, "cancelled");
});

test("drainOnce processa o próximo job e é single-flight", async () => {
  const cwd = setup();
  relay.enqueue(cwd, { requestId: "r1", to: "codex", payload: { prompt: "x" } });
  const r = await worker.drainOnce(cwd, { agentId: "codex", workerId: "w1", runTurn: okTurn, leaseMs: 1000 });
  assert.equal(r.outcome, "completed");
  const r2 = await worker.drainOnce(cwd, { agentId: "codex", workerId: "w2", runTurn: okTurn });
  assert.equal(r2, null); // nada queued
});

test("falha do turno marca o job como failed", async () => {
  const cwd = setup();
  const e = relay.enqueue(cwd, { requestId: "r1", to: "codex", payload: { prompt: "x" } });
  const c = relay.claim(cwd, e.jobId, "w1", 1000);
  const r = await worker.processJob(cwd, c.job, c.claimToken, {
    runTurn: async () => ({ ok: false, error: "boom" })
  });
  assert.equal(r.outcome, "failed");
  assert.equal(relay.getJob(cwd, e.jobId).errorMessage, "boom");
});

test("processJob não roda o turno se a posse venceu antes de começar (lost)", async () => {
  const cwd = setup();
  const e = relay.enqueue(cwd, { requestId: "r1", to: "codex", payload: { prompt: "x" } });
  const c = relay.claim(cwd, e.jobId, "w1", 40);
  await sleep(90);
  relay.list(cwd); // sweep: lease expirada (read-only) → requeue, claim solto
  let called = false;
  const r = await worker.processJob(cwd, c.job, c.claimToken, {
    runTurn: async () => {
      called = true;
      return { ok: true };
    }
  });
  assert.equal(called, false);
  assert.equal(r.outcome, "lost");
});

test("dispatchAndWait com executor que ignora o signal não trava (teto de espera)", async () => {
  const cwd = setup();
  const ignoreSignalTurn = () =>
    new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: true, output: "late", touchedFiles: [] }), 1000);
      t.unref?.();
    });
  const start = Date.now();
  const r = await worker.dispatchAndWait(cwd, {
    requestId: "r1",
    to: "codex",
    task: { prompt: "x" },
    runTurn: ignoreSignalTurn,
    timeoutMs: 80,
    abortGraceMs: 120,
    leaseMs: 10000,
    heartbeatMs: 5000
  });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - start < 600); // não esperou os 1000ms do turno
});

test("runWorkerLoop para rápido ao abortar durante o sono ocioso", async () => {
  const cwd = setup();
  const controller = new AbortController();
  const start = Date.now();
  const loopP = worker.runWorkerLoop(cwd, { agentId: "codex", intervalMs: 5000, signal: controller.signal, runTurn: okTurn });
  await sleep(50);
  controller.abort();
  await loopP;
  assert.ok(Date.now() - start < 1000); // não esperou os 5000ms do intervalo
});

test("runWorkerLoop sai automaticamente após idleTimeoutMs sem jobs", async () => {
  const cwd = setup();
  const start = Date.now();
  await worker.runWorkerLoop(cwd, {
    agentId: "codex",
    intervalMs: 20,
    idleTimeoutMs: 100,
    runTurn: okTurn
  });
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 100, `esperado >= 100ms, obtido ${elapsed}ms`);
  assert.ok(elapsed < 1000, `esperado < 1000ms, obtido ${elapsed}ms`);
});

test("runWorkerLoop: idleTimeout reseta quando um job é processado", async () => {
  const cwd = setup();
  relay.enqueue(cwd, { requestId: "idle-reset", to: "codex", payload: { prompt: "x" } });
  const start = Date.now();
  await worker.runWorkerLoop(cwd, {
    agentId: "codex",
    intervalMs: 20,
    idleTimeoutMs: 100,
    runTurn: okTurn
  });
  const elapsed = Date.now() - start;
  // processou o job antes e depois ficou idle >= 100ms antes de sair
  assert.ok(elapsed >= 100, `esperado >= 100ms, obtido ${elapsed}ms`);
  assert.ok(elapsed < 2000, `esperado < 2000ms, obtido ${elapsed}ms`);
  assert.equal(relay.findByRequestId(cwd, "idle-reset")?.relayState, "completed");
});

test("runWorkerLoop: idleTimeoutMs menor que intervalMs sai dentro do budget (não dorme o intervalo inteiro)", async () => {
  const cwd = setup();
  let called = false;
  const start = Date.now();
  await worker.runWorkerLoop(cwd, {
    agentId: "codex",
    intervalMs: 1000,
    idleTimeoutMs: 100,
    runTurn: async () => {
      called = true;
      return okTurn();
    }
  });
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 100, `esperado >= 100ms, obtido ${elapsed}ms`);
  // Sem o bound, o loop dormiria o intervalo inteiro (1000ms) antes de checar o timeout.
  assert.ok(elapsed < 500, `esperado < 500ms (não o intervalo inteiro), obtido ${elapsed}ms`);
  assert.equal(called, false);
});

test("runWorkerLoop: idleTimeoutMs=0 sai após o primeiro drain ocioso", async () => {
  const cwd = setup();
  const start = Date.now();
  await worker.runWorkerLoop(cwd, {
    agentId: "codex",
    intervalMs: 1000,
    idleTimeoutMs: 0,
    runTurn: okTurn
  });
  assert.ok(Date.now() - start < 500, "idleTimeoutMs=0 deveria sair quase imediatamente");
});

test("runWorkerLoop: idleTimeoutMs=null nunca sai por ociosidade (para apenas via signal)", async () => {
  const cwd = setup();
  const controller = new AbortController();
  const start = Date.now();
  const loopP = worker.runWorkerLoop(cwd, {
    agentId: "codex",
    intervalMs: 30,
    idleTimeoutMs: null,
    signal: controller.signal,
    runTurn: okTurn
  });
  await sleep(150);
  controller.abort();
  await loopP;
  // Se idleTimeoutMs fosse 0 ou algo que sai imediatamente, o elapsed seria << 150
  assert.ok(Date.now() - start >= 100, "loop não deveria sair antes do abort");
});

test("runWorkerLoop abortando durante um job em execução libera o job (read-only)", async () => {
  const cwd = setup();
  const e = relay.enqueue(cwd, { requestId: "r1", to: "codex", payload: { prompt: "x" } });
  const controller = new AbortController();
  const loopP = worker.runWorkerLoop(cwd, {
    agentId: "codex",
    intervalMs: 50,
    signal: controller.signal,
    runTurn: abortableTurn("done", 1000),
    leaseMs: 10000,
    heartbeatMs: 5000
  });
  await sleep(140); // job claimed + running
  controller.abort();
  await loopP;
  assert.equal(relay.getJob(cwd, e.jobId).relayState, "queued"); // liberado
});

test("write em execução com TTL expirado vira needs_recovery (não expired)", async () => {
  const cwd = setup();
  const e = relay.enqueue(cwd, {
    requestId: "w1",
    to: "codex",
    payload: { prompt: "x", write: true },
    ttlMs: 50,
    leaseExpiryPolicy: "park"
  });
  const c = relay.claim(cwd, e.jobId, "w1", 10000); // lease longa, não expira
  relay.startRunning(cwd, e.jobId, c.claimToken);
  await sleep(100); // TTL (50) expira, lease não
  assert.equal(relay.getJob(cwd, e.jobId).relayState, "needs_recovery");
});

test("complete antes de cancel: cancel falha e o completed permanece", async () => {
  const cwd = setup();
  const e = relay.enqueue(cwd, { requestId: "r1", to: "codex", payload: { prompt: "x" } });
  const c = relay.claim(cwd, e.jobId, "w1", 1000);
  relay.startRunning(cwd, e.jobId, c.claimToken);
  relay.complete(cwd, e.jobId, c.claimToken, { output: "ok" });
  const cancel = relay.cancel(cwd, e.jobId);
  assert.equal(cancel.ok, false);
  assert.equal(relay.getJob(cwd, e.jobId).relayState, "completed");
});

// --- needs_review (gate de revisão humana) --------------------------------

test("parseReviewMarker: aceita variantes de markdown/case, extrai o motivo e remove a linha", () => {
  const variants = [
    "resposta ok\nRELAY_NEEDS_REVIEW: mexe com dinheiro",
    "resposta ok\n**RELAY_NEEDS_REVIEW:** mexe com dinheiro",
    "resposta ok\n- relay_needs_review: mexe com dinheiro",
    "resposta ok\n`RELAY_NEEDS_REVIEW`: mexe com dinheiro",
    "resposta ok\nRelay_Needs_Review:   mexe com dinheiro  "
  ];
  for (const out of variants) {
    const p = worker.parseReviewMarker(out);
    assert.equal(p.needsReview, true, `deveria casar: ${JSON.stringify(out)}`);
    assert.equal(p.reason, "mexe com dinheiro");
    assert.ok(!/relay_needs_review/i.test(p.output), "linha do marcador removida do output");
    assert.equal(p.output, "resposta ok");
  }
});

test("parseReviewMarker: rejeita variantes negativas (none / n/a / not needed)", () => {
  for (const neg of ["none", "N/A", "not needed", "nenhum", "-"]) {
    const p = worker.parseReviewMarker(`ok\nRELAY_NEEDS_REVIEW: ${neg}`);
    assert.equal(p.needsReview, false, `deveria rejeitar: ${neg}`);
    assert.equal(p.reason, null);
  }
});

test("parseReviewMarker: sem marcador deixa o output intacto; só olha as últimas ~3 linhas", () => {
  const semMarcador = "só uma resposta normal\nsegunda linha";
  const p1 = worker.parseReviewMarker(semMarcador);
  assert.equal(p1.needsReview, false);
  assert.equal(p1.output, semMarcador);

  const marcadorNoTopo = "RELAY_NEEDS_REVIEW: no topo\nl2\nl3\nl4\nl5";
  const p2 = worker.parseReviewMarker(marcadorNoTopo);
  assert.equal(p2.needsReview, false);
  assert.equal(p2.output, marcadorNoTopo);
});

test("requireReview (predeclared) curto-circuita ANTES de startRunning/runTurn", async () => {
  const cwd = setup();
  const e = relay.enqueue(cwd, {
    requestId: "rr",
    to: "codex",
    payload: { prompt: "mexe com prod", requireReview: "toca produção" }
  });
  const c = relay.claim(cwd, e.jobId, "w1", 1000);
  let called = false;
  const r = await worker.processJob(cwd, c.job, c.claimToken, {
    runTurn: async () => {
      called = true;
      return { ok: true, output: "x" };
    }
  });
  assert.equal(called, false); // runTurn NUNCA chamado
  assert.equal(r.outcome, "needs_review_predeclared");
  const j = relay.getJob(cwd, e.jobId);
  assert.equal(j.relayState, "needs_review");
  assert.equal(j.reviewKind, "predeclared");
  assert.equal(j.riskReason, "toca produção");
});

test("requireReview em branco/whitespace NÃO curto-circuita (roda normalmente)", async () => {
  const cwd = setup();
  const e = relay.enqueue(cwd, {
    requestId: "rr-blank",
    to: "codex",
    payload: { prompt: "hi", requireReview: "   " }
  });
  const c = relay.claim(cwd, e.jobId, "w1", 1000);
  const r = await worker.processJob(cwd, c.job, c.claimToken, { runTurn: okTurn });
  assert.equal(r.outcome, "completed");
});

test("reviewClearedForRun=true faz o mesmo job pular o gate e rodar normalmente", async () => {
  const cwd = setup();
  const e = relay.enqueue(cwd, {
    requestId: "rr2",
    to: "codex",
    payload: { prompt: "hi", requireReview: "prod" }
  });
  // 1ª claim → curto-circuita em needs_review (predeclared).
  const c1 = relay.claim(cwd, e.jobId, "w1", 1000);
  const r1 = await worker.processJob(cwd, c1.job, c1.claimToken, { runTurn: okTurn });
  assert.equal(r1.outcome, "needs_review_predeclared");

  // Operador aprova → volta a queued com reviewClearedForRun.
  const res = relay.resolveReview(cwd, e.jobId, { approve: true, resolvedBy: "op" });
  assert.equal(res.ok, true);
  assert.equal(relay.getJob(cwd, e.jobId).relayState, "queued");

  // 2ª claim → agora roda o turno e completa (pula o gate).
  const c2 = relay.claim(cwd, e.jobId, "w2", 1000);
  let called = false;
  const r2 = await worker.processJob(cwd, c2.job, c2.claimToken, {
    runTurn: async () => {
      called = true;
      return { ok: true, output: "done", threadId: "t", touchedFiles: [] };
    }
  });
  assert.equal(called, true);
  assert.equal(r2.outcome, "completed");
  assert.equal(relay.getJob(cwd, e.jobId).relayState, "completed");
});

test("self-flag: turno com marcador entra em needs_review (selfflagged) e preserva worktree", async () => {
  const cwd = setup();
  const e = relay.enqueue(cwd, { requestId: "sf", to: "codex", payload: { prompt: "faz X" } });
  const c = relay.claim(cwd, e.jobId, "w1", 1000);
  const wt = { path: "/tmp/wt-x", branch: "relay/sf" };
  const r = await worker.processJob(cwd, c.job, c.claimToken, {
    runTurn: async () => ({
      ok: true,
      output: "fiz X mas precisa de revisão\nRELAY_NEEDS_REVIEW: envolve pagamento real",
      threadId: "t",
      touchedFiles: ["a.js"],
      worktree: wt
    })
  });
  assert.equal(r.outcome, "needs_review_selfflagged");
  const j = relay.getJob(cwd, e.jobId);
  assert.equal(j.relayState, "needs_review");
  assert.equal(j.reviewKind, "selfflagged");
  assert.equal(j.riskReason, "envolve pagamento real");
  assert.deepEqual(j.result.worktree, wt);
  // A linha do marcador foi removida do output persistido.
  assert.equal(j.result.output, "fiz X mas precisa de revisão");
  assert.ok(!/RELAY_NEEDS_REVIEW/.test(j.result.output));
});

test("postscript de revisão é sempre anexado ao prompt; resposta sem marcador completa normalmente", async () => {
  const cwd = setup();
  const e = relay.enqueue(cwd, { requestId: "ps", to: "codex", payload: { prompt: "só responda oi" } });
  const c = relay.claim(cwd, e.jobId, "w1", 1000);
  let gotPrompt = null;
  const r = await worker.processJob(cwd, c.job, c.claimToken, {
    runTurn: async (_c, opts) => {
      gotPrompt = opts.prompt;
      return { ok: true, output: "oi", threadId: "t", touchedFiles: [] };
    }
  });
  assert.equal(r.outcome, "completed");
  assert.ok(gotPrompt.startsWith("só responda oi"));
  assert.ok(gotPrompt.includes("RELAY_NEEDS_REVIEW"));
  assert.equal(relay.getJob(cwd, e.jobId).result.output, "oi");
});
