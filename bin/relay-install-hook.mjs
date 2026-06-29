#!/usr/bin/env node
// relay-install-hook.mjs — wire (or remove) the relay Stop-hook in a Claude Code
// settings.json, without hand-editing JSON.
//
//   node bin/relay-install-hook.mjs            # project .claude/settings.json
//   node bin/relay-install-hook.mjs --global   # ~/.claude/settings.json
//   node bin/relay-install-hook.mjs --remove    # tear it back out
//   node bin/relay-install-hook.mjs --print     # print the merged result, write nothing
//
// Idempotent: re-running never duplicates the entries. It registers the SAME
// command on both SessionStart (seed the baseline) and Stop (surface new jobs).
// See docs/examples/settings.hooks.json for what it injects and why.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "relay-stop-hook.mjs");
const COMMAND = `node ${HOOK}`;
const EVENTS = ["SessionStart", "Stop"];

const argv = new Set(process.argv.slice(2));
const remove = argv.has("--remove");
const print = argv.has("--print");
const target = argv.has("--global")
  ? path.join(os.homedir(), ".claude", "settings.json")
  : path.join(process.cwd(), ".claude", "settings.json");

function loadSettings(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

// Does this hook-group array already contain our command?
function hasCommand(groups) {
  return groups.some((g) => (g.hooks ?? []).some((h) => h.command === COMMAND));
}

function addToEvent(groups) {
  if (hasCommand(groups)) return groups;
  return [...groups, { hooks: [{ type: "command", command: COMMAND }] }];
}

function removeFromEvent(groups) {
  return groups
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => h.command !== COMMAND) }))
    .filter((g) => (g.hooks ?? []).length > 0);
}

const settings = loadSettings(target);
settings.hooks = settings.hooks ?? {};
for (const event of EVENTS) {
  const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  const next = remove ? removeFromEvent(groups) : addToEvent(groups);
  if (next.length > 0) settings.hooks[event] = next;
  else delete settings.hooks[event];
}
if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

const serialized = `${JSON.stringify(settings, null, 2)}\n`;
if (print) {
  process.stdout.write(serialized);
  process.exit(0);
}

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, serialized);
process.stderr.write(
  `[relay-install-hook] ${remove ? "removed from" : "wired into"} ${target}\n` +
    `[relay-install-hook] events: ${EVENTS.join(", ")}\n` +
    (remove ? "" : `[relay-install-hook] ensure RELAY_AGENT is set in the launching environment.\n`)
);
