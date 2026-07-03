import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import * as relay from "../lib/relay-jobs.mjs";

const CLI_BIN = fileURLToPath(new URL("../bin/relay-review.mjs", import.meta.url));

function makeEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-"));
  return {
    CLAUDE_PLUGIN_DATA: path.join(base, "data"),
    CLAUDE_PROJECT_DIR: path.join(base, "workspace")
  };
}

function runCli(env, args) {
  return spawnSync("node", [CLI_BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}

// Run a relay-jobs op against the SAME store the CLI subprocess will see
// (matching CLAUDE_PLUGIN_DATA), same pattern as tests/relay-mcp-server.test.mjs.
function relayOp(env, fn) {
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = env.CLAUDE_PLUGIN_DATA;
  try {
    return fn(env.CLAUDE_PROJECT_DIR);
  } finally {
    if (prev === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = prev;
    }
  }
}

// enqueue -> claim -> (startRunning se selfflagged) -> needsReview, all against env's
// store, returns the jobId. selfflagged só é aceito a partir de "running" (needsReview
// valida a combinação kind x estado de origem — ver lib/relay-jobs.mjs), então o setup
// precisa avançar o job até lá antes de sinalizar a revisão.
function makeNeedsReviewJob(env, { requestId, reviewKind, reason = "risco", result = null }) {
  return relayOp(env, (cwd) => {
    const a = relay.enqueue(cwd, { requestId, to: "codex", from: "claude" });
    const c = relay.claim(cwd, a.jobId, "w1", 60000);
    if (reviewKind === "selfflagged") {
      relay.startRunning(cwd, a.jobId, c.claimToken);
    }
    const n = relay.needsReview(cwd, a.jobId, c.claimToken, { reason, reviewKind, result });
    assert.equal(n.ok, true, "setup: needsReview deveria suceder");
    return a.jobId;
  });
}

test("list sem jobs em needs_review imprime mensagem e sai 0", () => {
  const env = makeEnv();
  const out = runCli(env, ["list"]);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /Nenhum job aguardando revisão\./);
});

test("list mostra um job needs_review real (id, to/from, kind, motivo)", () => {
  const env = makeEnv();
  const jobId = makeNeedsReviewJob(env, { requestId: "r1", reviewKind: "predeclared", reason: "mexe com dinheiro" });

  const out = runCli(env, ["list"]);
  assert.equal(out.status, 0);
  assert.match(out.stdout, new RegExp(jobId));
  assert.match(out.stdout, /to=codex/);
  assert.match(out.stdout, /from=claude/);
  assert.match(out.stdout, /kind=predeclared/);
  assert.match(out.stdout, /mexe com dinheiro/);
});

test("approve num job predeclared volta pra queued e sai 0", () => {
  const env = makeEnv();
  const jobId = makeNeedsReviewJob(env, { requestId: "r1", reviewKind: "predeclared" });

  const out = runCli(env, ["approve", jobId, "--note", "ok pode rodar", "--by", "breno"]);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /aprovado/);
  assert.match(out.stdout, /fila/);

  const job = relayOp(env, (cwd) => relay.getJob(cwd, jobId));
  assert.equal(job.relayState, "queued");
  assert.equal(job.reviewResolvedBy, "breno");
  assert.equal(job.reviewNote, "ok pode rodar");
});

test("approve num job selfflagged vira completed", () => {
  const env = makeEnv();
  const jobId = makeNeedsReviewJob(env, {
    requestId: "r2",
    reviewKind: "selfflagged",
    result: { output: "feito" }
  });

  const out = runCli(env, ["approve", jobId]);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /completed/);

  const job = relayOp(env, (cwd) => relay.getJob(cwd, jobId));
  assert.equal(job.relayState, "completed");
});

test("reject vira failed e sai 0", () => {
  const env = makeEnv();
  const jobId = makeNeedsReviewJob(env, { requestId: "r3", reviewKind: "predeclared" });

  const out = runCli(env, ["reject", jobId, "--note", "não autorizado"]);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /rejeitado/);
  assert.match(out.stdout, /failed/);

  const job = relayOp(env, (cwd) => relay.getJob(cwd, jobId));
  assert.equal(job.relayState, "failed");
  assert.equal(job.reviewNote, "não autorizado");
});

test("approve num jobId inexistente sai 1 com mensagem em stderr", () => {
  const env = makeEnv();
  const out = runCli(env, ["approve", "job-nao-existe"]);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /não encontrado/);
});

test("reject num job que não está em needs_review sai 1 com mensagem em stderr", () => {
  const env = makeEnv();
  const jobId = relayOp(env, (cwd) => relay.enqueue(cwd, { requestId: "r4" }).jobId);

  const out = runCli(env, ["reject", jobId]);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /não está aguardando revisão/);
  assert.match(out.stderr, /queued/);
});

test("comando desconhecido ou sem argumentos imprime uso e sai 1", () => {
  const env = makeEnv();
  const out1 = runCli(env, []);
  assert.equal(out1.status, 1);
  assert.match(out1.stderr, /uso:/);

  const out2 = runCli(env, ["bogus"]);
  assert.equal(out2.status, 1);
  assert.match(out2.stderr, /uso:/);
});
