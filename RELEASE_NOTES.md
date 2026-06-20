Fix warm-pool trigger runtime auth

- Fix warm-pool claimed sessions so their sandbox token is re-scoped to the real session before the spare row is removed.
- Restart/reconfigure OpenCode after claim so Executor MCP, LLM gateway, and project config are available for manual and cron trigger sessions.
