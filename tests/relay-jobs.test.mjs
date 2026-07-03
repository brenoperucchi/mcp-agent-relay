import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as relay from "../lib/relay-jobs.mjs";
import { resolveStateDir } from "../lib/store-paths.mjs";

// A constant non-git workspace dir → resolveWorkspaceRoot falls back to it.
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cwd-"));

// Each test gets a fresh CLAUDE_PLUGIN_DATA, so the relay store path is unique
// (isolation does not depend on the workspace slug).
function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-data-"));
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  return { cwd: CWD };
}

function mkClock(start = 1000) {
  const state = { t: start };
  return {
    now: () => state.t,
    advance: (ms) => {
      state.t += ms;
    }
  };
}

function storeFile(cwd) {
  return path.join(resolveStateDir(cwd), "relay-state.json");
}

test("enqueue cria job queued e deduplica por requestId", () => {
  const { cwd } = setup();
  const o = { clock: mkClock().now };

  const a = relay.enqueue(cwd, { requestId: "r1", to: "codex", payload: { x: 1 } }, o);
  assert.equal(a.deduped, false);
  assert.equal(a.job.relayState, "queued");

  const b = relay.enqueue(cwd, { requestId: "r1" }, o);
  assert.equal(b.deduped, true);
  assert.equal(b.jobId, a.jobId);

  assert.equal(relay.list(cwd, o).length, 1);
});

test("enqueue sem requestId é rejeitado", () => {
  const { cwd } = setup();
  assert.throws(() => relay.enqueue(cwd, {}), /requestId/);
});

test("dedup devolve o result cacheado após complete", () => {
  const { cwd } = setup();
  const o = { clock: mkClock().now };

  const a = relay.enqueue(cwd, { requestId: "r1" }, o);
  const c = relay.claim(cwd, a.jobId, "w1", 1000, o);
  const done = relay.complete(cwd, a.jobId, c.claimToken, { answer: 42 }, o);
  assert.equal(done.ok, true);

  const again = relay.enqueue(cwd, { requestId: "r1" }, o);
  assert.equal(again.deduped, true);
  assert.equal(again.job.relayState, "completed");
  assert.deepEqual(again.job.result, { answer: 42 });
});

test("claim só funciona a partir de queued; segundo claim retorna null", () => {
  const { cwd } = setup();
  const o = { clock: mkClock().now };

  const a = relay.enqueue(cwd, { requestId: "r1" }, o);
  const c1 = relay.claim(cwd, a.jobId, "w1", 1000, o);
  assert.ok(c1 && c1.claimToken);
  assert.equal(relay.getJob(cwd, a.jobId, o).relayState, "claimed");

  const c2 = relay.claim(cwd, a.jobId, "w2", 1000, o);
  assert.equal(c2, null);
});

test("lease vencido vira requeue no sweep-on-access (attempts++)", () => {
  const { cwd } = setup();
  const clk = mkClock();
  const o = { clock: clk.now };

  const a = relay.enqueue(cwd, { requestId: "r1" }, o);
  relay.claim(cwd, a.jobId, "w1", 100, o);
  clk.advance(200);

  const j = relay.list(cwd, o).find((x) => x.id === a.jobId);
  assert.equal(j.relayState, "queued");
  assert.equal(j.attempts, 1);
});

test("fencing: worker com lease vencido não completa job reatribuído", () => {
  const { cwd } = setup();
  const clk = mkClock();
  const o = { clock: clk.now };

  const a = relay.enqueue(cwd, { requestId: "r1" }, o);
  const c1 = relay.claim(cwd, a.jobId, "w1", 100, o);
  clk.advance(200);
  relay.list(cwd, o); // sweep-on-access requeues the expired claim
  const c2 = relay.claim(cwd, a.jobId, "w2", 1000, o);
  assert.ok(c2.claimToken);
  assert.notEqual(c2.claimToken, c1.claimToken);

  const stale = relay.complete(cwd, a.jobId, c1.claimToken, { bad: true }, o);
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "stale_claim_token");

  const good = relay.complete(cwd, a.jobId, c2.claimToken, { good: true }, o);
  assert.equal(good.ok, true);
  assert.deepEqual(relay.getJob(cwd, a.jobId, o).result, { good: true });
});

test("TTL do job vira expired no sweep", () => {
  const { cwd } = setup();
  const clk = mkClock();
  const o = { clock: clk.now };

  const a = relay.enqueue(cwd, { requestId: "r1", ttlMs: 100 }, o);
  clk.advance(200);
  assert.equal(relay.getJob(cwd, a.jobId, o).relayState, "expired");
});

test("maxAttempts: lease vencido além do limite vira failed", () => {
  const { cwd } = setup();
  const clk = mkClock();
  const o = { clock: clk.now };

  const a = relay.enqueue(cwd, { requestId: "r1", maxAttempts: 1 }, o);
  relay.claim(cwd, a.jobId, "w1", 10, o);
  clk.advance(50);

  const j = relay.getJob(cwd, a.jobId, o);
  assert.equal(j.relayState, "failed");
  assert.equal(j.attempts, 1);
});

test("cancel torna o job cancelled e impede novo claim", () => {
  const { cwd } = setup();
  const o = { clock: mkClock().now };

  const a = relay.enqueue(cwd, { requestId: "r1" }, o);
  const c = relay.cancel(cwd, a.jobId, o);
  assert.equal(c.ok, true);
  assert.equal(relay.getJob(cwd, a.jobId, o).relayState, "cancelled");
  assert.equal(relay.claim(cwd, a.jobId, "w1", 100, o), null);
});

test("complete é idempotente com o mesmo claim token", () => {
  const { cwd } = setup();
  const o = { clock: mkClock().now };

  const a = relay.enqueue(cwd, { requestId: "r1" }, o);
  const c = relay.claim(cwd, a.jobId, "w1", 1000, o);
  const d1 = relay.complete(cwd, a.jobId, c.claimToken, { r: 1 }, o);
  const d2 = relay.complete(cwd, a.jobId, c.claimToken, { r: 1 }, o);
  assert.equal(d1.ok, true);
  assert.equal(d2.ok, true);
});

test("fail terminal e fail com retry", () => {
  const { cwd } = setup();
  const o = { clock: mkClock().now };

  const a = relay.enqueue(cwd, { requestId: "r1" }, o);
  const ca = relay.claim(cwd, a.jobId, "w1", 1000, o);
  const f = relay.fail(cwd, a.jobId, ca.claimToken, "boom", { clock: o.clock });
  assert.equal(f.ok, true);
  assert.equal(f.job.relayState, "failed");

  const b = relay.enqueue(cwd, { requestId: "r2", maxAttempts: 3 }, o);
  const cb = relay.claim(cwd, b.jobId, "w1", 1000, o);
  const f2 = relay.fail(cwd, b.jobId, cb.claimToken, "again", { retry: true, clock: o.clock });
  assert.equal(f2.ok, true);
  assert.equal(f2.job.relayState, "queued");
  assert.equal(f2.job.attempts, 1);
});

test("durabilidade: o estado é persistido em disco e relido", () => {
  const { cwd } = setup();
  const o = { clock: mkClock().now };

  const a = relay.enqueue(cwd, { requestId: "r1" }, o);
  relay.claim(cwd, a.jobId, "w1", 1000, o);

  const file = storeFile(cwd);
  assert.ok(fs.existsSync(file));
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(parsed.jobs[0].relayState, "claimed");

  // A fresh read (re-loads from disk) sees the persisted state.
  assert.equal(relay.getJob(cwd, a.jobId, o).relayState, "claimed");
});

test("store corrompido falha alto até reset explícito, nunca vira fila vazia", () => {
  const { cwd } = setup();
  const o = { clock: mkClock().now };

  relay.enqueue(cwd, { requestId: "r1" }, o);
  const file = storeFile(cwd);
  fs.writeFileSync(file, "{ isto não é json", "utf8");

  // Falha alto em TODA chamada — nunca silenciosamente vazio.
  assert.throws(() => relay.list(cwd, o), /corrompido/);
  assert.throws(() => relay.list(cwd, o), /corrompido/);
  assert.throws(() => relay.enqueue(cwd, { requestId: "r2" }, o), /corrompido/);

  // Recuperação explícita arquiva o arquivo ruim e recomeça limpo.
  relay.resetStore(cwd);
  const dir = path.dirname(file);
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith("relay-state.json.corrupt-"));
  assert.equal(backups.length, 1);
  assert.equal(relay.list(cwd, o).length, 0);
});

test("índice é reconstruído dos jobs: store sem index não permite enqueue duplicado", () => {
  const { cwd } = setup();
  const o = { clock: mkClock().now };

  const a = relay.enqueue(cwd, { requestId: "r1" }, o);

  // Inconsistência semântica: zerar o index no arquivo, mantendo o job.
  const file = storeFile(cwd);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  parsed.index = {};
  fs.writeFileSync(file, JSON.stringify(parsed), "utf8");

  // enqueue do mesmo requestId deve deduplicar (índice reconstruído a partir do job).
  const b = relay.enqueue(cwd, { requestId: "r1" }, o);
  assert.equal(b.deduped, true);
  assert.equal(b.jobId, a.jobId);
  assert.equal(relay.list(cwd, o).length, 1);
});

test("leitura sem mudança não reescreve o store", () => {
  const { cwd } = setup();
  const o = { clock: mkClock().now };

  relay.enqueue(cwd, { requestId: "r1" }, o);
  const file = storeFile(cwd);
  const m1 = fs.statSync(file).mtimeMs;

  relay.list(cwd, o);
  relay.getJob(cwd, "inexistente", o);
  relay.findByRequestId(cwd, "r1", o);

  assert.equal(fs.statSync(file).mtimeMs, m1);
});

test("operações com lease vencido falham (sweep-on-access requeue antes)", () => {
  const { cwd } = setup();
  const clk = mkClock();
  const o = { clock: clk.now };

  const a = relay.enqueue(cwd, { requestId: "r1" }, o);
  const c = relay.claim(cwd, a.jobId, "w1", 100, o);
  clk.advance(200); // lease vence

  // Qualquer acesso roda o sweep primeiro → o job volta a queued e o token velho é inválido.
  assert.equal(relay.heartbeat(cwd, a.jobId, c.claimToken, 100, o).ok, false);
  assert.equal(relay.release(cwd, a.jobId, c.claimToken, o).ok, false);
  assert.equal(relay.startRunning(cwd, a.jobId, c.claimToken, o).ok, false);
  assert.equal(relay.getJob(cwd, a.jobId, o).relayState, "queued");
});

// --- needs_review (gate de revisão humana) --------------------------------

test("needsReview: needs_review e PRUNABLE_TERMINAL_STATES estão nas constantes esperadas", () => {
  assert.ok(relay.RELAY_STATES.includes("needs_review"));
  assert.ok(relay.TERMINAL_STATES.includes("needs_review"));
  assert.deepEqual([...relay.PRUNABLE_TERMINAL_STATES], ["completed", "failed", "cancelled", "expired"]);
  // needs_review e needs_recovery são terminais mas NÃO prunáveis.
  assert.ok(!relay.PRUNABLE_TERMINAL_STATES.includes("needs_review"));
  assert.ok(!relay.PRUNABLE_TERMINAL_STATES.includes("needs_recovery"));
});

test("needsReview é fenced pelo claimToken (token errado falha, correto entra em needs_review)", () => {
  const { cwd } = setup();
  const o = { clock: mkClock().now };
  const a = relay.enqueue(cwd, { requestId: "r1" }, o);
  const c = relay.claim(cwd, a.jobId, "w1", 1000, o);

  const bad = relay.needsReview(cwd, a.jobId, "token-errado", { reason: "x", reviewKind: "predeclared" }, o);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "stale_claim_token");
  assert.equal(relay.getJob(cwd, a.jobId, o).relayState, "claimed");

  const good = relay.needsReview(
    cwd,
    a.jobId,
    c.claimToken,
    { reason: "mexe com dinheiro", reviewKind: "predeclared" },
    o
  );
  assert.equal(good.ok, true);
  const j = relay.getJob(cwd, a.jobId, o);
  assert.equal(j.relayState, "needs_review");
  assert.equal(j.riskReason, "mexe com dinheiro");
  assert.equal(j.reviewKind, "predeclared");
  assert.equal(j.claim, null);
});

test("needsReview aceita origem claimed E running", () => {
  const { cwd } = setup();
  const o = { clock: mkClock().now };

  // a partir de claimed (predeclared)
  const a = relay.enqueue(cwd, { requestId: "r1" }, o);
  const ca = relay.claim(cwd, a.jobId, "w1", 1000, o);
  const na = relay.needsReview(cwd, a.jobId, ca.claimToken, { reason: "p", reviewKind: "predeclared" }, o);
  assert.equal(na.ok, true);
  assert.equal(relay.getJob(cwd, a.jobId, o).relayState, "needs_review");

  // a partir de running (selfflagged)
  const b = relay.enqueue(cwd, { requestId: "r2" }, o);
  const cb = relay.claim(cwd, b.jobId, "w1", 1000, o);
  relay.startRunning(cwd, b.jobId, cb.claimToken, o);
  const nb = relay.needsReview(cwd, b.jobId, cb.claimToken, { reason: "s", reviewKind: "selfflagged" }, o);
  assert.equal(nb.ok, true);
  assert.equal(relay.getJob(cwd, b.jobId, o).relayState, "needs_review");
});

test("needsReview preserva worktree no result parcial (selfflagged)", () => {
  const { cwd } = setup();
  const o = { clock: mkClock().now };
  const a = relay.enqueue(cwd, { requestId: "r1" }, o);
  const c = relay.claim(cwd, a.jobId, "w1", 1000, o);
  relay.startRunning(cwd, a.jobId, c.claimToken, o);
  const wt = { path: "/tmp/wt", branch: "relay/x" };
  const n = relay.needsReview(
    cwd,
    a.jobId,
    c.claimToken,
    { reason: "s", reviewKind: "selfflagged", result: { output: "parcial", threadId: "t", touchedFiles: ["a"], worktree: wt } },
    o
  );
  assert.equal(n.ok, true);
  const j = relay.getJob(cwd, a.jobId, o);
  assert.deepEqual(j.result.worktree, wt);
  assert.equal(j.result.output, "parcial");
});

test("needsReview em job já terminal falha com already_terminal", () => {
  const { cwd } = setup();
  const o = { clock: mkClock().now };
  const a = relay.enqueue(cwd, { requestId: "r1" }, o);
  const c = relay.claim(cwd, a.jobId, "w1", 1000, o);
  relay.complete(cwd, a.jobId, c.claimToken, { done: true }, o);
  const n = relay.needsReview(cwd, a.jobId, c.claimToken, { reason: "x", reviewKind: "predeclared" }, o);
  assert.equal(n.ok, false);
  assert.equal(n.reason, "already_terminal");
});

test("needsReview rejeita reviewKind inválido (não muda o estado do job)", () => {
  const { cwd } = setup();
  const o = { clock: mkClock().now };
  const a = relay.enqueue(cwd, { requestId: "r1" }, o);
  const c = relay.claim(cwd, a.jobId, "w1", 1000, o);

  const n = relay.needsReview(cwd, a.jobId, c.claimToken, { reason: "x", reviewKind: "bogus" }, o);
  assert.equal(n.ok, false);
  assert.equal(n.reason, "invalid_review_kind");
  assert.equal(relay.getJob(cwd, a.jobId, o).relayState, "claimed");
});

test("needsReview rejeita combinação errada de reviewKind x estado de origem", () => {
  const { cwd } = setup();
  const o = { clock: mkClock().now };

  // selfflagged a partir de claimed (deveria ser running) → mismatch
  const a = relay.enqueue(cwd, { requestId: "r1" }, o);
  const ca = relay.claim(cwd, a.jobId, "w1", 1000, o);
  const na = relay.needsReview(cwd, a.jobId, ca.claimToken, { reason: "s", reviewKind: "selfflagged" }, o);
  assert.equal(na.ok, false);
  assert.equal(na.reason, "review_kind_state_mismatch");
  assert.equal(relay.getJob(cwd, a.jobId, o).relayState, "claimed");

  // predeclared a partir de running (deveria ser claimed) → mismatch
  const b = relay.enqueue(cwd, { requestId: "r2" }, o);
  const cb = relay.claim(cwd, b.jobId, "w1", 1000, o);
  relay.startRunning(cwd, b.jobId, cb.claimToken, o);
  const nb = relay.needsReview(cwd, b.jobId, cb.claimToken, { reason: "p", reviewKind: "predeclared" }, o);
  assert.equal(nb.ok, false);
  assert.equal(nb.reason, "review_kind_state_mismatch");
  assert.equal(relay.getJob(cwd, b.jobId, o).relayState, "running");
});

test("resolveReview: guard não-needs_review devolve erro estruturado (não lança)", () => {
  const { cwd } = setup();
  const o = { clock: mkClock().now };
  const a = relay.enqueue(cwd, { requestId: "r1" }, o);
  // job está queued, não needs_review
  const r = relay.resolveReview(cwd, a.jobId, { approve: true }, o);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not_needs_review");
  // inexistente
  const r2 = relay.resolveReview(cwd, "inexistente", { approve: true }, o);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, "not_found");
});

test("resolveReview predeclared+approve volta a queued (não completed): attempts=0, reviewClearedForRun, terminalAtMs nulo", () => {
  const { cwd } = setup();
  const clk = mkClock(1000);
  const o = { clock: clk.now };
  const a = relay.enqueue(cwd, { requestId: "r1" }, o);
  const c = relay.claim(cwd, a.jobId, "w1", 1000, o);
  relay.needsReview(cwd, a.jobId, c.claimToken, { reason: "prod", reviewKind: "predeclared" }, o);

  clk.advance(500);
  const r = relay.resolveReview(cwd, a.jobId, { approve: true, resolvedBy: "breno", note: "ok liberado" }, o);
  assert.equal(r.ok, true);
  const j = relay.getJob(cwd, a.jobId, o);
  assert.equal(j.relayState, "queued");
  assert.equal(j.attempts, 0);
  assert.equal(j.reviewClearedForRun, true);
  assert.equal(j.claim, null);
  assert.equal(j.terminalAtMs, null);
  assert.equal(j.reviewResolvedBy, "breno");
  assert.equal(j.reviewResolvedAtMs, 1500);
  assert.equal(j.reviewNote, "ok liberado");
});

test("resolveReview selfflagged+approve vira completed mantendo o result original", () => {
  const { cwd } = setup();
  const o = { clock: mkClock().now };
  const a = relay.enqueue(cwd, { requestId: "r1" }, o);
  const c = relay.claim(cwd, a.jobId, "w1", 1000, o);
  relay.startRunning(cwd, a.jobId, c.claimToken, o);
  const result = { output: "resposta final", threadId: "t", touchedFiles: [] };
  relay.needsReview(cwd, a.jobId, c.claimToken, { reason: "dinheiro", reviewKind: "selfflagged", result }, o);

  const r = relay.resolveReview(cwd, a.jobId, { approve: true }, o);
  assert.equal(r.ok, true);
  const j = relay.getJob(cwd, a.jobId, o);
  assert.equal(j.relayState, "completed");
  assert.deepEqual(j.result, result);
});

test("resolveReview reject vira failed (qualquer kind) e reseta terminalAtMs na resolução", () => {
  const { cwd } = setup();
  const clk = mkClock(1000);
  const o = { clock: clk.now };

  // predeclared reject
  const a = relay.enqueue(cwd, { requestId: "r1" }, o);
  const ca = relay.claim(cwd, a.jobId, "w1", 1000, o);
  relay.needsReview(cwd, a.jobId, ca.claimToken, { reason: "p", reviewKind: "predeclared" }, o);
  const nrAt = relay.getJob(cwd, a.jobId, o).terminalAtMs;
  clk.advance(1234);
  const ra = relay.resolveReview(cwd, a.jobId, { approve: false, note: "não autorizado" }, o);
  assert.equal(ra.ok, true);
  const ja = relay.getJob(cwd, a.jobId, o);
  assert.equal(ja.relayState, "failed");
  assert.equal(ja.errorMessage, "não autorizado");
  assert.equal(ja.terminalAtMs, nrAt + 1234); // reset na resolução, não na entrada em needs_review

  // selfflagged reject usa a mensagem padrão quando note é null
  const b = relay.enqueue(cwd, { requestId: "r2" }, o);
  const cb = relay.claim(cwd, b.jobId, "w1", 1000, o);
  relay.startRunning(cwd, b.jobId, cb.claimToken, o);
  relay.needsReview(cwd, b.jobId, cb.claimToken, { reason: "s", reviewKind: "selfflagged", result: { output: "x" } }, o);
  const rb = relay.resolveReview(cwd, b.jobId, { approve: false }, o);
  assert.equal(rb.ok, true);
  const jb = relay.getJob(cwd, b.jobId, o);
  assert.equal(jb.relayState, "failed");
  assert.equal(jb.errorMessage, "rejeitado na revisão humana");
});

test("resolveReview: defesa em profundidade — reviewKind corrompido dentro de needs_review não vira completed", () => {
  const { cwd } = setup();
  const o = { clock: mkClock().now };
  const a = relay.enqueue(cwd, { requestId: "r1" }, o);
  const c = relay.claim(cwd, a.jobId, "w1", 1000, o);
  relay.needsReview(cwd, a.jobId, c.claimToken, { reason: "p", reviewKind: "predeclared" }, o);

  // needsReview() já bloqueia reviewKind inválido na entrada — para exercitar o `else`
  // de defesa em profundidade em resolveReview, corrompe o reviewKind diretamente no
  // arquivo do store (nunca pelo caminho público).
  const file = storeFile(cwd);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  parsed.jobs.find((j) => j.id === a.jobId).reviewKind = "bogus";
  fs.writeFileSync(file, JSON.stringify(parsed), "utf8");

  const r = relay.resolveReview(cwd, a.jobId, { approve: true }, o);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid_review_kind");
  const j = relay.getJob(cwd, a.jobId, o);
  assert.equal(j.relayState, "needs_review"); // nunca vira completed com um kind inválido
});

test("retenção: needs_review e needs_recovery sobrevivem ao sweep muito além de retentionMs", () => {
  const { cwd } = setup();
  const clk = mkClock(1000);
  const o = { clock: clk.now };

  const a = relay.enqueue(cwd, { requestId: "r1" }, o);
  const ca = relay.claim(cwd, a.jobId, "w1", 100000, o);
  relay.needsReview(cwd, a.jobId, ca.claimToken, { reason: "p", reviewKind: "predeclared" }, o);

  const b = relay.enqueue(cwd, { requestId: "r2" }, o);
  const cb = relay.claim(cwd, b.jobId, "w1", 100000, o);
  relay.park(cwd, b.jobId, cb.claimToken, "parked", o);

  // avança MUITO além da retenção padrão (24h)
  clk.advance(1000 * 60 * 60 * 24 * 30); // 30 dias
  const states = relay
    .list(cwd, o)
    .map((j) => j.relayState)
    .sort();
  assert.deepEqual(states, ["needs_recovery", "needs_review"]);
});

test("retenção hard-cap: descarta completed/failed antigos antes de needs_review/needs_recovery", () => {
  const { cwd } = setup();
  const clk = mkClock(1000);
  const o = { clock: clk.now };

  // 3 jobs terminais "normais" (completed), os mais antigos.
  const done = [];
  for (let i = 0; i < 3; i++) {
    const e = relay.enqueue(cwd, { requestId: `done-${i}` }, o);
    const c = relay.claim(cwd, e.jobId, "w1", 1000, o);
    relay.complete(cwd, e.jobId, c.claimToken, { i }, o);
    done.push(e.jobId);
    clk.advance(10); // terminalAtMs crescente
  }

  // needs_review + needs_recovery (mais novos).
  const nv = relay.enqueue(cwd, { requestId: "nv" }, o);
  const cnv = relay.claim(cwd, nv.jobId, "w1", 1000, o);
  relay.needsReview(cwd, nv.jobId, cnv.claimToken, { reason: "p", reviewKind: "predeclared" }, o);
  clk.advance(10);
  const nr = relay.enqueue(cwd, { requestId: "nr" }, o);
  const cnr = relay.claim(cwd, nr.jobId, "w1", 1000, o);
  relay.park(cwd, nr.jobId, cnr.claimToken, "parked", o);

  // hard-cap agressivo (1) + retenção enorme (o tempo não poda nada) → só o hard-cap age.
  // Mesmo acima do cap, os 2 jobs de revisão sobrevivem: só completed/failed são descartáveis.
  const bigRetention = 1000 * 60 * 60 * 24 * 365;
  const jobs = relay.list(cwd, { clock: clk.now, maxJobs: 1, retentionMs: bigRetention });
  const ids = jobs.map((j) => j.id);
  assert.equal(jobs.length, 2);
  assert.ok(ids.includes(nv.jobId));
  assert.ok(ids.includes(nr.jobId));
  for (const d of done) assert.ok(!ids.includes(d));
});
