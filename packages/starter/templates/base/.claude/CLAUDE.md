# Claude Code runtime

This directory is the Claude Code runtime profile for this Kortix project.

- Runtime profile: `claude`
- Harness: Claude Code
- Project configuration: `../kortix.yaml`
- Project skills: `../.kortix/opencode/skills`

Use the Kortix system skill for project, session, secret, connector, and CLI
contracts. Runtime behavior remains native to Claude Code.

Authentication uses one of these project credentials:

- `CLAUDE_CODE_OAUTH_TOKEN`, generated with `claude setup-token`
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_AUTH_TOKEN`

Do not write credentials into this repository.
