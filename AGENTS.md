# Repository guidance

## Agent Relay Wait Policy

For read-only reviews dispatched through the `agentrelay` MCP server:

- For `claude-opus` and `claude-fable`, call `dispatch_wait` exactly once with a
  stable `request_id` and `timeout_ms: 600000`.
- Do not loop on `agentrelay.poll` or emit progress updates while the job is running.
  Polling reads state only; it does not advance the Claude turn.
- If `dispatch_wait` times out, inspect the job at most once, report the `job_id` and
  state, and wait for explicit user direction before polling again.
- Use `poll` only for a user-requested status check or relay-failure diagnosis.
