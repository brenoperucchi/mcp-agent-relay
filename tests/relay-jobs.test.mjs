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
