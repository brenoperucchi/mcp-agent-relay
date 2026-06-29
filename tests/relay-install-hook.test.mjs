import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_BIN = path.join(HERE, "..", "bin", "relay-install-hook.mjs");
const HOOK_BIN = path.join(HERE, "..", "bin", "relay-stop-hook.mjs");
const COMMAND = `node ${HOOK_BIN}`;

function run(cwd, args = []) {
  execFileSync("node", [INSTALL_BIN, ...args], { cwd, encoding: "utf8", stdio: "pipe" });
}

function readSettings(cwd) {
  return JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8"));
}

function countCommand(settings) {
  let n = 0;
  for (const groups of Object.values(settings.hooks ?? {})) {
    for (const g of groups) for (const h of g.hooks ?? []) if (h.command === COMMAND) n++;
  }
  return n;
}

test("install wires SessionStart + Stop once each", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "relay-install-"));
  run(cwd);
  const s = readSettings(cwd);
  assert.equal(countCommand(s), 2);
  assert.ok(s.hooks.SessionStart && s.hooks.Stop);
});

test("install is idempotent across repeated runs", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "relay-install-"));
  run(cwd);
  run(cwd);
  run(cwd);
  assert.equal(countCommand(readSettings(cwd)), 2, "never duplicates");
});

test("install preserves unrelated settings and existing hooks", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "relay-install-"));
  fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".claude", "settings.json"),
    JSON.stringify({
      model: "opus",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo keep" }] }] }
    })
  );
  run(cwd);
  const s = readSettings(cwd);
  assert.equal(s.model, "opus");
  // our command + the pre-existing echo both present under Stop
  const stopCmds = s.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(stopCmds.includes("echo keep"));
  assert.ok(stopCmds.includes(COMMAND));
});

test("--remove tears out only our entries", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "relay-install-"));
  fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".claude", "settings.json"),
    JSON.stringify({
      model: "opus",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo keep" }] }] }
    })
  );
  run(cwd);
  run(cwd, ["--remove"]);
  const s = readSettings(cwd);
  assert.equal(countCommand(s), 0, "our command gone");
  assert.equal(s.model, "opus", "unrelated key preserved");
  const stopCmds = s.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
  assert.deepEqual(stopCmds, ["echo keep"], "pre-existing hook preserved");
});

test("--print writes nothing to disk", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "relay-install-"));
  const out = execFileSync("node", [INSTALL_BIN, "--print"], { cwd, encoding: "utf8" });
  assert.match(out, /relay-stop-hook\.mjs/);
  assert.ok(!fs.existsSync(path.join(cwd, ".claude", "settings.json")), "no file written in --print mode");
});
