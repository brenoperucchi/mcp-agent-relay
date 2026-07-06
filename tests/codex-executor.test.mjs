import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { codexExecRunTurn, ABORT_GRACE_MS } from "../lib/codex-executor.mjs";

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// A fake `codex` that ignores SIGTERM, spawns a GRANDCHILD (which also ignores SIGTERM), and
// runs forever — so a correct abort must group-SIGKILL both codex AND its grandchild.
function fakeCodexDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-codex-"));
  const bin = path.join(dir, "codex");
  fs.writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "process.on('SIGTERM',()=>{});",
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const gc = spawn(process.execPath, ['-e','process.on(\\\"SIGTERM\\\",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });",
      "if (process.env.GC_PIDFILE) { try { fs.writeFileSync(process.env.GC_PIDFILE, String(gc.pid)); } catch {} }",
      "setInterval(()=>{},1000);",
      ""
    ].join("\n")
  );
  fs.chmodSync(bin, 0o755);
  return dir;
}

test("abort group-kills codex AND its grandchild even if they ignore SIGTERM (bounded)", async () => {
  const dir = fakeCodexDir();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fake-codex-cwd-"));
  const gcPidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gc-")), "pid");
  const savedPath = process.env.PATH;
  const savedGc = process.env.GC_PIDFILE;
  process.env.PATH = `${dir}:${savedPath}`; // codexExecRunTurn resolves `codex` from PATH
  process.env.GC_PIDFILE = gcPidFile;
  try {
    const ac = new AbortController();
    const p = codexExecRunTurn(cwd, { prompt: "hello", signal: ac.signal });
    // wait for the grandchild to exist
    for (let i = 0; i < 40 && !fs.existsSync(gcPidFile); i++) await delay(50);
    const gcPid = Number(fs.readFileSync(gcPidFile, "utf8"));
    const t0 = Date.now();
    ac.abort();
    const res = await p;
    const elapsed = Date.now() - t0;
    assert.equal(res.ok, false);
    assert.ok(elapsed < ABORT_GRACE_MS + 1500, `turn should settle within the abort grace; took ${elapsed}ms`);
    // the grandchild belongs to codex's process group, so it must die too
    let gcDead = false;
    for (let i = 0; i < 40; i++) {
      if (!pidAlive(gcPid)) {
        gcDead = true;
        break;
      }
      await delay(50);
    }
    if (!gcDead) {
      try { process.kill(gcPid, "SIGKILL"); } catch {}
    }
    assert.ok(gcDead, "the codex grandchild must be killed by the process-group SIGKILL");
  } finally {
    process.env.PATH = savedPath;
    if (savedGc === undefined) delete process.env.GC_PIDFILE;
    else process.env.GC_PIDFILE = savedGc;
  }
});

test("a missing codex binary fails cleanly (no throw, ok=false)", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "no-codex-cwd-"));
  const savedPath = process.env.PATH;
  process.env.PATH = path.join(os.tmpdir(), "definitely-empty-bin-dir-xyz");
  try {
    const res = await codexExecRunTurn(cwd, { prompt: "hello" });
    assert.equal(res.ok, false);
    assert.ok(res.error);
  } finally {
    process.env.PATH = savedPath;
  }
});

test("passes explicit model and effort to codex exec", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-codex-args-"));
  const bin = path.join(dir, "codex");
  const argvFile = path.join(dir, "argv.json");
  fs.writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.ARGV_FILE, JSON.stringify(process.argv.slice(2)));",
      "const outIdx = process.argv.indexOf('--output-last-message');",
      "if (outIdx >= 0) fs.writeFileSync(process.argv[outIdx + 1], 'ok');",
      ""
    ].join("\n")
  );
  fs.chmodSync(bin, 0o755);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fake-codex-args-cwd-"));
  const savedPath = process.env.PATH;
  const savedArgv = process.env.ARGV_FILE;
  process.env.PATH = `${dir}:${savedPath}`;
  process.env.ARGV_FILE = argvFile;
  try {
    const res = await codexExecRunTurn(cwd, {
      prompt: "hello",
      model: "gpt-5.5",
      effort: "xhigh"
    });
    assert.equal(res.ok, true);
    const args = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(args.includes("-m"));
    assert.equal(args[args.indexOf("-m") + 1], "gpt-5.5");
    assert.ok(args.includes("-c"));
    assert.equal(args[args.indexOf("-c") + 1], 'model_reasoning_effort="xhigh"');
  } finally {
    process.env.PATH = savedPath;
    if (savedArgv === undefined) delete process.env.ARGV_FILE;
    else process.env.ARGV_FILE = savedArgv;
  }
});
