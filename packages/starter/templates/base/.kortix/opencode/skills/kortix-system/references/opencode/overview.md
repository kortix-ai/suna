# OpenCode reference — overview

OpenCode is the agent runtime that powers every Kortix session. The
same `.kortix/opencode/` config dir drives both surfaces:

- **Remote** — when a Kortix session boots, the platform points OpenCode
  at this dir via `OPENCODE_CONFIG_DIR=.kortix/opencode` and launches
  the agent inside the sandbox VM.
- **Local** — when you (or anyone) runs `opencode` in this repo on
  their machine, the same config dir drives that session too.

So whatever you add here works in both places — no two parallel sets
of configs to keep in sync.

This folder mirrors the upstream OpenCode docs as standalone Markdown
files so an agent can read them without a network fetch. Pages are
canonical when they match upstream; if something here drifts, the
linked upstream page wins.

## Pages

| Topic                       | File             | Upstream                                                                          |
| --------------------------- | ---------------- | --------------------------------------------------------------------------------- |
| Agents                      | `agents.md`      | <https://opencode.ai/docs/agents/>                                                |
| Skills                      | `skills.md`      | <https://opencode.ai/docs/skills/>                                                |
| Commands                    | `commands.md`    | <https://opencode.ai/docs/commands/>                                              |
| Tools (built-in + custom)   | `tools.md`       | <https://opencode.ai/docs/tools/> + <https://opencode.ai/docs/custom-tools/>      |
| Plugins                     | `plugins.md`     | <https://opencode.ai/docs/plugins/>                                               |
| MCP servers                 | `mcp-servers.md` | <https://opencode.ai/docs/mcp-servers/>                                           |
| Permissions                 | `permissions.md` | <https://opencode.ai/docs/permissions/>                                           |
| Rules (`AGENTS.md`)         | `rules.md`       | <https://opencode.ai/docs/rules/>                                                 |
| Models                      | `models.md`      | <https://opencode.ai/docs/models/>                                                |

## Where OpenCode looks for things in a Kortix project

OpenCode discovers its config from `OPENCODE_CONFIG_DIR`, which the
Kortix runtime sets to `.kortix/opencode/`. So everything below is
rooted there.

| Surface       | Path inside the Kortix project                                                              |
| ------------- | ------------------------------------------------------------------------------------------- |
| Config root   | `.kortix/opencode/opencode.jsonc`                                                           |
| Agents        | `.kortix/opencode/agents/<name>.md`                                                         |
| Skills        | `.kortix/opencode/skills/<name>/SKILL.md`                                                   |
| Commands      | `.kortix/opencode/commands/<name>.md`                                                       |
| Custom tools  | `.kortix/opencode/tools/<file>.ts`                                                          |
| Plugins       | `.kortix/opencode/plugins/<file>.ts` (+ `.kortix/opencode/package.json` for npm deps)       |
| MCP servers   | `.kortix/opencode/opencode.jsonc` → `mcp` key                                               |

## The contract with Kortix

OpenCode owns everything under `.kortix/opencode/`. The Kortix platform
never reads any of it — those files only matter to OpenCode itself.

Conversely, Kortix-specific config (triggers, secrets schema, sandbox
image, deployable apps, project metadata) lives in `kortix.toml` at
the repo root. OpenCode never reads `kortix.toml`.

Both halves are versioned in the same repo, but the boundary is
strict — see `references/kortix-toml.md` for the Kortix half.
