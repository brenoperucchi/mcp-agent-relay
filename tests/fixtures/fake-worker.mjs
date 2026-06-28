#!/usr/bin/env node
// Fake worker daemon for worker-lifecycle tests. Parses the lifecycle's CLI args and emits
// the same heartbeat shape, atomically. Env knobs:
//   RELAY_FAKE_SILENT=1         -> never heartbeat (forces a readiness timeout)
//   RELAY_FAKE_IGNORE_SIGTERM=1 -> ignore SIGTERM (forces SIGKILL escalation)
//   RELAY_FAKE_PIDFILE=<path>   -> write own pid there (so a test can assert it died)
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
let hbFile = null;
let token = null;
let interval = 200;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--heartbeat-file") hbFile = argv[++i];
  else if (argv[i] === "--worker-token") token = argv[++i];
  else if (argv[i] === "--interval") interval = Number(argv[++i]) || interval;
}

if (process.env.RELAY_FAKE_PIDFILE) {
  try { fs.writeFileSync(process.env.RELAY_FAKE_PIDFILE, String(process.pid)); } catch {}
}
if (process.env.RELAY_FAKE_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {});
}
const silent = process.env.RELAY_FAKE_SILENT === "1";

function beat() {
  if (silent || !hbFile || !token) return;
  const dir = path.dirname(hbFile);
  const tmp = path.join(dir, `.${path.basename(hbFile)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, token, ts: Date.now() }));
  fs.renameSync(tmp, hbFile);
}
beat();
setInterval(beat, interval); // also keeps the process alive
