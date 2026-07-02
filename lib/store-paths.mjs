// store-paths.mjs — per-workspace state dir + id helpers for the relay.
// Self-contained (no plugin dependency). Data root resolution order:
//   RELAY_DATA_DIR  >  $CLAUDE_PLUGIN_DATA/state  >  ~/.mcp-agent-relay/state
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const JOBS_DIR_NAME = "jobs";
const WORKTREES_DIR_NAME = "worktrees";

function resolveStateRoot() {
  if (process.env.RELAY_DATA_DIR) return process.env.RELAY_DATA_DIR;
  if (process.env.CLAUDE_PLUGIN_DATA) return path.join(process.env.CLAUDE_PLUGIN_DATA, "state");
  return path.join(os.homedir(), ".mcp-agent-relay", "state");
}

export function resolveWorkspaceRoot(cwd) {
  try {
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch {
    // not a git repo / git unavailable
  }
  return cwd;
}

function computeStateSlugHash(workspaceRoot) {
  let canonical = workspaceRoot;
  try {
    canonical = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonical = workspaceRoot;
  }
  const base = path.basename(workspaceRoot) || "workspace";
  const slug = base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return `${slug}-${hash}`;
}

export function resolveStateDir(cwd) {
  return path.join(resolveStateRoot(), computeStateSlugHash(resolveWorkspaceRoot(cwd)));
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(path.join(resolveStateDir(cwd), JOBS_DIR_NAME), { recursive: true });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function resolveJobEventFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME, `${jobId}.events.jsonl`);
}

export function resolveWorktreesDir(cwd) {
  return path.join(resolveStateDir(cwd), WORKTREES_DIR_NAME);
}
