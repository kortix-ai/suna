# OpenCode reference — overview

OpenCode is one supported Kortix runtime harness. Version 2 uses OpenCode REST.
Version 3 can select OpenCode ACP, Claude Code, Codex, or Pi. This directory is
the complete OpenCode-specific reference. It does not define other harnesses.

When a project selects OpenCode, the same `.kortix/opencode/` config directory
can drive both surfaces:

- **Remote** — when a Kortix session boots, the platform points OpenCode
  at this dir via `OPENCODE_CONFIG_DIR=.kortix/opencode` and launches
  the agent inside the sandbox VM.
- **Local** — when you (or anyone) runs `opencode` in this repo on
  their machine, the same config dir drives that session too.

OpenCode-specific files can therefore serve both local and remote OpenCode.
Claude Code, Codex, and Pi use their own native configuration directories. See
`../kortix/runtime-harnesses.md` for the multi-harness contract.

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

OpenCode owns the behavior under `.kortix/opencode/`. Kortix can inspect agent
metadata and overlays current managed system skills, but it does not reinterpret
OpenCode prompts, permissions, tools, providers, or plugins.

Conversely, Kortix-specific config (triggers, secrets schema, sandbox
image, project metadata) lives in `kortix.yaml` at
the repo root. OpenCode never reads `kortix.yaml`.

Both halves are versioned in the same repo, but the boundary is
strict — see `../kortix/kortix-yaml.md` for the Kortix half.
