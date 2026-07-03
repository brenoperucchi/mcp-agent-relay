#!/usr/bin/env node
// relay-review.mjs — human-only CLI to list and resolve needs_review jobs.
//
// CLI-only ON PURPOSE (no MCP tool): the agent that dispatched the risky job
// already holds the session's MCP tools. If "approve review" were an MCP tool,
// the gated agent could self-approve its own gate, which defeats the point.
// Resolution therefore only exists as a terminal command a human runs by hand.
//
//   node bin/relay-review.mjs list
//   node bin/relay-review.mjs approve <jobId> [--note "texto"] [--by "nome"]
//   node bin/relay-review.mjs reject  <jobId> [--note "texto"] [--by "nome"]

import { list, getJob, resolveReview } from "../lib/relay-jobs.mjs";

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function usage() {
  process.stderr.write(
    "uso:\n" +
      "  node bin/relay-review.mjs list\n" +
      '  node bin/relay-review.mjs approve <jobId> [--note "texto"] [--by "nome"]\n' +
      '  node bin/relay-review.mjs reject  <jobId> [--note "texto"] [--by "nome"]\n'
  );
}

// Manual, dependency-free flag scan (same style as bin/relay-install-hook.mjs):
// pulls out --note/--by and returns whatever positional args are left.
function parseArgs(args) {
  const flags = { note: null, by: null };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--note") {
      flags.note = args[++i] ?? null;
    } else if (arg === "--by") {
      flags.by = args[++i] ?? null;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function formatElapsed(sinceMs) {
  const deltaMs = Math.max(0, Date.now() - (sinceMs ?? Date.now()));
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `há ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `há ${minutes}min`;
  const hours = Math.floor(minutes / 60);
  return `há ${hours}h`;
}

function cmdList() {
  const jobs = list(cwd).filter((job) => job.relayState === "needs_review");
  if (jobs.length === 0) {
    process.stdout.write("Nenhum job aguardando revisão.\n");
    process.exit(0);
  }
  for (const job of jobs) {
    const waitSince = job.terminalAtMs ?? job.enqueuedAtMs;
    const reason = job.riskReason ?? "(sem motivo)";
    process.stdout.write(
      `${job.id}  to=${job.to ?? "-"} from=${job.from ?? "-"}  kind=${job.reviewKind ?? "-"}  ` +
        `motivo: ${reason}  (${formatElapsed(waitSince)})\n`
    );
  }
  process.exit(0);
}

function reportResolveError(jobId, res) {
  if (res.reason === "not_found") {
    process.stderr.write(`job não encontrado: ${jobId}\n`);
  } else if (res.reason === "not_needs_review") {
    process.stderr.write(
      `job não está aguardando revisão (estado atual: ${res.job?.relayState ?? "desconhecido"})\n`
    );
  } else {
    process.stderr.write(`falha ao resolver job ${jobId}: ${res.reason ?? "erro desconhecido"}\n`);
  }
  process.exit(1);
}

function cmdApprove(jobId, flags) {
  // Capture reviewKind BEFORE resolving so the confirmation message can tell
  // apart "predeclared" (goes back to the queue) from "selfflagged" (accepted
  // as completed) — resolveReview already applies the state transition.
  const before = getJob(cwd, jobId);
  const res = resolveReview(cwd, jobId, { approve: true, note: flags.note, resolvedBy: flags.by });
  if (!res.ok) {
    reportResolveError(jobId, res);
    return;
  }
  const reviewKind = before?.reviewKind ?? res.job.reviewKind;
  if (reviewKind === "predeclared") {
    process.stdout.write(`Job ${jobId} aprovado — voltou pra fila e vai rodar agora.\n`);
  } else {
    process.stdout.write(`Job ${jobId} aprovado — resultado aceito, marcado como completed.\n`);
  }
  process.exit(0);
}

function cmdReject(jobId, flags) {
  const res = resolveReview(cwd, jobId, { approve: false, note: flags.note, resolvedBy: flags.by });
  if (!res.ok) {
    reportResolveError(jobId, res);
    return;
  }
  process.stdout.write(`Job ${jobId} rejeitado — marcado como failed.\n`);
  process.exit(0);
}

const [command, ...rest] = process.argv.slice(2);
const { flags, positional } = parseArgs(rest);

if (command === "list") {
  cmdList();
} else if (command === "approve" || command === "reject") {
  const jobId = positional[0];
  if (!jobId) {
    usage();
    process.exit(1);
  }
  if (command === "approve") {
    cmdApprove(jobId, flags);
  } else {
    cmdReject(jobId, flags);
  }
} else {
  usage();
  process.exit(1);
}
