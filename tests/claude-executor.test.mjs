import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { createClaudeRunTurn } from "../lib/claude-executor.mjs";

function fakeSpawn({ code = 0, stdout = "answer", stderr = "", onSpawn } = {}) {
  return (command, args, options) => {
    onSpawn?.(command, args, options);
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", code);
    });
    return child;
  };
}

test("Claude executor uses only its allowlisted binary and agent, ignoring payload command fields", async () => {
  let called;
  const runTurn = createClaudeRunTurn("deep-reasoner", {
    spawnImpl: fakeSpawn({ onSpawn: (...args) => { called = args; } })
  });
  const result = await runTurn("/workspace", {
    prompt: "review this",
    command: "evil",
    args: ["--dangerously-skip-permissions"],
    agent: "fable-reasoner",
    env: { SECRET: "no" }
  });
  assert.equal(result.ok, true);
  assert.equal(result.output, "answer");
  assert.equal(called[0], "claude");
  assert.deepEqual(called[1], ["-p", "--agent", "deep-reasoner", "--permission-mode", "plan", "--", "review this"]);
  assert.equal(called[2].env.SECRET, undefined);
});

test("Claude executor makes a flag-looking prompt positional after --", async () => {
  let args;
  const runTurn = createClaudeRunTurn("fable-reasoner", {
    spawnImpl: fakeSpawn({ onSpawn: (_command, actualArgs) => { args = actualArgs; } })
  });
  await runTurn("/workspace", { prompt: "--dangerously-skip-permissions" });
  assert.equal(args.at(-2), "--");
  assert.equal(args.at(-1), "--dangerously-skip-permissions");
});

test("Claude executor reports CLI failure and empty final response", async () => {
  const failed = await createClaudeRunTurn("deep-reasoner", { spawnImpl: fakeSpawn({ code: 1, stdout: "", stderr: "not authenticated" }) })("/w", { prompt: "x" });
  assert.deepEqual(failed, { ok: false, output: null, threadId: null, touchedFiles: [], error: "not authenticated" });
  const empty = await createClaudeRunTurn("deep-reasoner", { spawnImpl: fakeSpawn({ stdout: "   " }) })("/w", { prompt: "x" });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /sem resposta final/i);
});

test("Claude executor abort terminates its process group", async () => {
  let child;
  const calls = [];
  const runTurn = createClaudeRunTurn("deep-reasoner", {
    killImpl: (pid, signal) => calls.push([pid, signal]),
    spawnImpl: () => {
      child = new EventEmitter();
      child.pid = 4242;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = (signal) => calls.push(["child", signal]);
      return child;
    }
  });
  const ac = new AbortController();
  const pending = runTurn("/w", { prompt: "x", signal: ac.signal });
  ac.abort();
  child.emit("close", 143);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.deepEqual(calls[0], [-4242, "SIGTERM"]);
});
