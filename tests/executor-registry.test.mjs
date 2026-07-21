import test from "node:test";
import assert from "node:assert/strict";

import { getExecutor, executorIds } from "../lib/executor-registry.mjs";

test("executor registry resolves the explicit codex and Claude worker ids", () => {
  assert.deepEqual(executorIds(), ["codex", "claude-opus", "claude-fable"]);
  assert.equal(getExecutor("codex").id, "codex");
  assert.equal(getExecutor("claude-opus").claudeAgent, "deep-reasoner");
  assert.equal(getExecutor("claude-fable").claudeAgent, "fable-reasoner");
});

test("executor registry rejects unknown worker ids", () => {
  assert.equal(getExecutor("claude").ok, false);
  assert.equal(getExecutor("anything-from-payload").ok, false);
});

