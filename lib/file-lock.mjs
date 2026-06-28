// file-lock.mjs — the relay's proven interprocess lock, extracted so both the job
// store (relay-jobs.mjs) and the worker daemon lifecycle (worker-lifecycle.mjs) share
// ONE correct implementation on different lock files.
//
// Ownership nonce + atomic exclusive create (open "wx") + atomic-rename steal of a stale
// lock + conditional release (only unlink if the lock is still ours). The wait is a
// SYNCHRONOUS busy-wait (Atomics.wait, no CPU spin): `fn` MUST be synchronous — never
// hold this lock across an `await`, or you freeze the event loop.

import fs from "node:fs";
import path from "node:path";

export const DEFAULT_LOCK_TIMEOUT_MS = 5000;
export const DEFAULT_LOCK_STALE_MS = 30000;

export class FileLockTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "FileLockTimeoutError";
    this.code = "LOCK_TIMEOUT";
  }
}

function sleepSync(ms) {
  // Synchronous sleep without spinning the CPU; used only for lock retries.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withFileLock(
  lockFile,
  fn,
  {
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    lockStaleMs = DEFAULT_LOCK_STALE_MS,
    makeTimeoutError = (message) => new FileLockTimeoutError(message)
  } = {}
) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const nonce = `${process.pid}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const start = Date.now();

  for (;;) {
    try {
      const fd = fs.openSync(lockFile, "wx"); // atomic exclusive create
      try {
        fs.writeSync(fd, nonce);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      break; // acquired
    } catch (err) {
      if (err.code !== "EEXIST") {
        throw err;
      }
      // Stale lock? Steal it via an atomic rename — only the process whose rename
      // succeeds removes it; everyone else gets ENOENT and retries open(wx).
      try {
        const st = fs.statSync(lockFile);
        if (Date.now() - st.mtimeMs > lockStaleMs) {
          const stealing = `${lockFile}.stale-${nonce}`;
          fs.renameSync(lockFile, stealing);
          fs.unlinkSync(stealing);
          continue;
        }
      } catch {
        // Lock vanished or was stolen by another process; just retry.
      }
      if (Date.now() - start > lockTimeoutMs) {
        throw makeTimeoutError(`timeout aguardando o lock (${lockFile})`);
      }
      sleepSync(20);
    }
  }

  try {
    return fn();
  } finally {
    // Conditional release: only remove the lock if it is still OURS, so we can
    // never delete a lock that another process acquired after stealing ours.
    try {
      if (fs.readFileSync(lockFile, "utf8") === nonce) {
        fs.unlinkSync(lockFile);
      }
    } catch {
      // Lock already gone or unreadable.
    }
  }
}
