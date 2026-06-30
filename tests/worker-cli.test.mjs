import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs } from "../worker.mjs";

test("parseArgs: --idle-timeout 0 é preservado (sai após o primeiro drain ocioso)", () => {
  const args = parseArgs(["--idle-timeout", "0"]);
  assert.equal(args.idleTimeoutMs, 0);
});

test("parseArgs: --idle-timeout com valor positivo", () => {
  const args = parseArgs(["--idle-timeout", "1500"]);
  assert.equal(args.idleTimeoutMs, 1500);
});

test("parseArgs: --idle-timeout inválido vira null (não roda pra sempre por engano)", () => {
  assert.equal(parseArgs(["--idle-timeout", "abc"]).idleTimeoutMs, null);
  assert.equal(parseArgs(["--idle-timeout", "-5"]).idleTimeoutMs, null);
});

test("parseArgs: sem --idle-timeout o default é null (loop infinito até signal)", () => {
  assert.equal(parseArgs([]).idleTimeoutMs, null);
});

test("parseArgs: flags básicas", () => {
  const args = parseArgs(["--agent", "codex", "--once", "--allow-writes", "--interval", "250"]);
  assert.equal(args.agent, "codex");
  assert.equal(args.once, true);
  assert.equal(args.allowWrites, true);
  assert.equal(args.intervalMs, 250);
});
