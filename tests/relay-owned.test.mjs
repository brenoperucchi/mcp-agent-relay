import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sanitizeSessionId, ownedFile, readOwned, recordOwned, ensureOwnedFile } from "../lib/relay-owned.mjs";
import { resolveStateDir } from "../lib/store-paths.mjs";

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-owned-data-"));
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-owned-cwd-"));
}

test("sanitizeSessionId strips unsafe characters and caps length", () => {
  assert.equal(sanitizeSessionId("a/b c"), "a-b-c");
  assert.equal(sanitizeSessionId(""), "default");
  assert.equal(sanitizeSessionId(null), "default");
  assert.equal(sanitizeSessionId("x".repeat(200)).length, 80);
});

test("readOwned returns null when the file is missing or corrupt", () => {
  const cwd = setup();
  assert.equal(readOwned(cwd, "nope"), null);

  const file = ownedFile(cwd, "corrupt");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{not json");
  assert.equal(readOwned(cwd, "corrupt"), null);
});

test("recordOwned + readOwned round-trip and merge across calls", () => {
  const cwd = setup();
  recordOwned(cwd, "s1", ["job-a"]);
  recordOwned(cwd, "s1", ["job-a:completed:9", "job-b"]);
  const owned = readOwned(cwd, "s1");
  assert.ok(owned instanceof Set);
  assert.deepEqual([...owned].sort(), ["job-a", "job-a:completed:9", "job-b"]);
});

test("recordOwned is a no-op without a sessionId or with empty entries", () => {
  const cwd = setup();
  recordOwned(cwd, null, ["job-a"]);
  recordOwned(cwd, "s2", []);
  assert.equal(fs.existsSync(ownedFile(cwd, "s2")), false);
});

test("ensureOwnedFile creates an empty, session-aware file when none exists", () => {
  const cwd = setup();
  assert.equal(readOwned(cwd, "fresh"), null, "nothing yet");
  ensureOwnedFile(cwd, "fresh");
  const owned = readOwned(cwd, "fresh");
  assert.ok(owned instanceof Set, "file now exists, so the session is session-aware");
  assert.equal(owned.size, 0, "but owns nothing yet");
});

test("ensureOwnedFile never overwrites an existing (possibly non-empty) file", () => {
  const cwd = setup();
  recordOwned(cwd, "existing", ["job-a"]);
  ensureOwnedFile(cwd, "existing");
  const owned = readOwned(cwd, "existing");
  assert.ok(owned.has("job-a"), "pre-existing data must survive ensureOwnedFile");
});

test("ensureOwnedFile is a no-op without a sessionId", () => {
  const cwd = setup();
  ensureOwnedFile(cwd, null);
  assert.equal(fs.existsSync(path.join(resolveStateDir(cwd), "owned-default.json")), false);
});
