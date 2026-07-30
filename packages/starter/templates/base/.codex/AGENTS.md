# Codex runtime

This directory is the Codex runtime profile for this Kortix project.

- Runtime profile: `codex`
- Harness: Codex
- Project configuration: `../kortix.yaml`
- Project skills: `../.kortix/opencode/skills`

Use the Kortix system skill for project, session, secret, connector, and CLI
contracts. Runtime behavior remains native to Codex.

Authentication uses one of these project credentials:

- `CODEX_AUTH_JSON`, created by the ChatGPT device authorization flow
- `OPENAI_API_KEY`
- `CODEX_API_KEY`

Do not write credentials into this repository.
