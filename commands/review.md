---
description: Adversarially review a file with Codex via the agentrelay relay (dispatch, then wait for the verdict)
argument-hint: <path-to-file> [extra focus notes]
---

Use the **agentrelay** MCP server to have **Codex** adversarially review a file, and return its
verdict here. This is synchronous from your point of view: you dispatch the job, then poll until
it finishes, then relay Codex's result. You do **not** review the file yourself — Codex does.

Target (a file path, plus any focus notes): **$ARGUMENTS**

Steps:

1. Choose a fresh unique `request_id`, e.g. `review-` + a short random suffix.

2. Call `mcp__agentrelay__dispatch` with:
   - `to`: `"codex"`
   - `request_id`: the id from step 1
   - `task`: an **object** (not a string) of the form `{ "prompt": "<REVIEW PROMPT>" }`

   Build `<REVIEW PROMPT>` as:
   > You are an adversarial reviewer. Read the file at the path given here (resolve it from the
   > current workspace): **$ARGUMENTS**. Review it critically — find concrete problems, gaps,
   > risks, and edge cases, citing specific locations. End with a single line
   > `VERDICT: approve | approve_with_changes | needs_rework`, then a numbered list of REQUIRED
   > (blocking) changes and a separate list of OPTIONAL suggestions. Be terse; no praise.

3. Note the returned `job_id`. Poll for the result: call `mcp__agentrelay__poll` with that
   `job_id`. If `state` is not terminal (i.e. not one of `completed` / `failed` /
   `needs_recovery` / `cancelled` / `expired`), wait briefly (you may run `sleep 3` via Bash),
   then poll again. Repeat until the state is terminal (give it up to ~20 polls — a Codex turn
   usually finishes within ~30s).

4. When terminal:
   - `completed` → present Codex's review verbatim from `result.output`, clearly attributed to
     Codex (e.g. "Codex's review:"). Do not editorialize or add your own verdict.
   - any failure state → report the `state` and `error`. Common causes: no worker is running to
     execute the job (the daemon auto-spawns only when `RELAY_WORKER_AUTOSPAWN` is set for the
     agentrelay server), or the file path could not be read. Suggest the fix.

Notes:
- The job is dispatched to the `codex` worker; it runs `codex exec` read-only over the workspace,
  so Codex reads `$ARGUMENTS` itself — you do not need to paste the file contents into the prompt.
- Keep the `task` as a JSON **object**; the relay tolerates a stringified payload, but an object
  is the contract.
