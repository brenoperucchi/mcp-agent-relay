# Repository guidance

## Agent Relay Wait Policy

For read-only reviews dispatched through the `agentrelay` MCP server:

- For `claude-opus` and `claude-fable`, first call `dispatch` with a stable
  `request_id` to retain the `job_id` immediately. If the result is needed inline,
  call `dispatch_wait` once with the same `to`, `task`, and `request_id`;
  deduplication prevents a second job.
- Set `dispatch_wait.timeout_ms` to at most `240000`. The Codex MCP client has a
  300-second tool-call deadline, so a 600-second wait loses the response and its `job_id`.
- Put the review text in `task.prompt`, for example
  `task: { prompt: "review …" }`. A root-level `prompt`, or a `task` without a
  non-empty string `prompt`, is invalid and must not be retried unchanged.
- Do not loop on `agentrelay.poll` or emit progress updates while the job is running.
  Polling reads state only; it does not advance the Claude turn.
- If `dispatch_wait` returns `timed_out: true`, retain and report its `job_id` and
  state. Do not ask the user merely for permission to collect the requested review:
  when the relay sends that job's terminal completion notification, perform exactly
  one targeted `poll` and return the result. Without a completion notification,
  return the known state and `job_id` without periodic polling.
- Use `poll` for a user-requested status check, a terminal completion notification
  for a review the same user requested, or relay-failure diagnosis.
