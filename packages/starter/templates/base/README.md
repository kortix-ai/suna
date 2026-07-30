# {{projectName}}

This project supports four ACP harnesses:

- OpenCode
- Claude Code
- Codex
- Pi

Select the matching agent when you create a session. A session keeps its
selected harness for its complete lifetime. Start a new session to use another
harness.

## Authentication

- OpenCode can use Kortix-managed models or project provider credentials.
- Claude Code accepts `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or
  `CLAUDE_CODE_OAUTH_TOKEN`.
- Codex accepts `CODEX_AUTH_JSON`, `OPENAI_API_KEY`, or `CODEX_API_KEY`.
- Pi accepts `OPENAI_API_KEY` or `CODEX_API_KEY`.

Use the project Models view to connect credentials. Do not commit credentials.

## Test each harness

1. Create a session with the `opencode` agent.
2. Send a real prompt.
3. Confirm that the response completes.
4. Repeat with the `claude`, `codex`, and `pi` agents.

A provider availability check does not prove prompt execution. Test the exact
harness and model that the project will use.

Run `kortix system-skills get kortix-system --full` for the current platform
instructions. Run `kortix schema --version 3` for the exact manifest schema.
