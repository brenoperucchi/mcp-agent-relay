// relay-owned.mjs — per-session "owned" record: which jobs a specific Claude Code
// session dispatched, and which terminal transitions it has already been told about
// (inline via dispatch_wait, or via the MCP channel). One JSON array of strings per
// session, mixing two shapes so a single Set membership test serves both purposes:
//   bare job id            "relay-1a2b3c-x7y8z9"                  → dispatch-time whitelist
//   full terminal key      "relay-1a2b3c-x7y8z9:completed:169..." → delivery-time exclusion
// Written ONLY by whoever dispatches (server.mjs); read-only for the Stop hook.
import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "./store-paths.mjs";
import { withFileLock } from "./file-lock.mjs";

const MAX_ENTRIES = 2000;
const KEEP_ON_TRIM = 1000;

export function sanitizeSessionId(id) {
  return String(id || "default").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "default";
}

export function ownedFile(cwd, sessionId) {
  return path.join(resolveStateDir(cwd), `owned-${sanitizeSessionId(sessionId)}.json`);
}

// Read-only load. Returns null (not an empty Set) when the file is missing/corrupt,
// so callers can distinguish "no data yet → fallback" from "data says empty".
export function readOwned(cwd, sessionId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ownedFile(cwd, sessionId), "utf8"));
    return Array.isArray(parsed) ? new Set(parsed) : null;
  } catch {
    return null;
  }
}

// Idempotent, best-effort: create an EMPTY owned-file for this session if none
// exists yet. Without this, a sibling session that hasn't dispatched anything of
// its own has no owned-file at all, so readOwned() returns null and every
// consumer falls back FULLY to legacy agentId-only filtering — meaning it can
// still be woken by a sibling's job until its own first dispatch. Calling this
// once at server startup (server.mjs, where SESSION_ID is known) closes that gap:
// the session becomes "session aware" (owns nothing yet) as soon as it exists,
// not only after it dispatches something.
export function ensureOwnedFile(cwd, sessionId) {
  if (!sessionId) return;
  const file = ownedFile(cwd, sessionId);
  if (fs.existsSync(file)) return;
  try {
    withFileLock(`${file}.lock`, () => {
      if (fs.existsSync(file)) return; // created by someone else while we waited for the lock
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify([]));
      fs.renameSync(tmp, file);
    });
  } catch {
    // best-effort — never block server startup on this
  }
}

// Synchronous, lock-protected append. `entries` is an array of strings to add.
// Best-effort: swallow lock/write errors so a dispatch/delivery is NEVER blocked or
// failed by this bookkeeping (fallback for the hook is always "behave like today").
export function recordOwned(cwd, sessionId, entries) {
  if (!sessionId || !entries?.length) return;
  const file = ownedFile(cwd, sessionId);
  try {
    withFileLock(`${file}.lock`, () => {
      let arr = [];
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (Array.isArray(parsed)) arr = parsed;
      } catch {
        // missing/corrupt → start fresh
      }
      const set = new Set(arr);
      for (const e of entries) set.add(e);
      let out = [...set];
      if (out.length > MAX_ENTRIES) out = out.slice(out.length - KEEP_ON_TRIM);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(out));
      fs.renameSync(tmp, file);
    });
  } catch {
    // lock timeout / fs error: never let ownership bookkeeping break dispatch or delivery.
  }
}
