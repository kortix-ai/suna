# Pi runtime

This directory is the Pi runtime profile for this Kortix project.

- Runtime profile: `pi`
- Harness: Pi
- Project configuration: `../kortix.yaml`
- Project skills: `../.kortix/opencode/skills`

Use the Kortix system skill for project, session, secret, connector, and CLI
contracts. Runtime behavior remains native to Pi.

Authentication uses `OPENAI_API_KEY` or `CODEX_API_KEY`. Kortix can also
materialize managed gateway configuration into Pi's native `models.json`.

Do not write credentials into this repository.
