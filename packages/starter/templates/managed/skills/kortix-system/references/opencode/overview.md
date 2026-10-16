# OpenCode reference — overview

OpenCode is one of the two Kortix session harnesses. The other is pi
(`../pi/overview.md`). This directory is the complete OpenCode reference.

In a `kortix_version: 3` project, `kortix.yaml` is the only source of
OpenCode config. Kortix compiles the manifest (and every file it imports)
and the session daemon gives OpenCode the result. OpenCode reads no project
config folder: not `harnesses/opencode/`, `.kortix/opencode/` or
`.opencode/`, and no `opencode.json` or `opencode.jsonc` from the project.

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

## Where each OpenCode concept lives in a Kortix project

The upstream pages listed above describe OpenCode's own config files. In a v3
project, each concept is a key in `kortix.yaml` instead:

| OpenCode concept | `kortix_version: 3` key |
| ---------------- | ----------------------- |
| Agents (`opencode.json` `agent`, `.opencode/agents/*.md`) | `agents.<name>`: one block with `prompt` or `prompt_file`, `model`, `mode`, `permission`, … |
| Built-in agents `build`, `plan`, `general`, `explore` | Off unless `agents` declares that name. |
| Subagents an agent may call (`permission.task`) | `agents.<name>.subagents` |
| Permissions (`permission`) | `agents.<name>.permission`, per agent. Omitted: `allow`. No project-wide permission. |
| Skills (`.opencode/skills/`, `permission.skill`) | `skills:` registry (name → folder) and `agents.<name>.skills` |
| Commands (`.opencode/commands/*.md`) | `commands:` registry and `agents.<name>.commands` |
| Custom tools (`.opencode/tools/`) | `tools:` registry (name → module); both harnesses run it (`../kortix/tools.md`) |
| Tool visibility (`tools`) | `agents.<name>.tools`: `all`, `none`, a list, or `{ exclude: [...] }` |
| Plugins (`.opencode/plugins/`, `plugin`) | `extensions.<name>.opencode` (a repo module) and `agents.<name>.extensions` |
| MCP servers (`mcp`) | `connectors` with `provider: mcp` |
| Custom providers (`provider`) | No v3 key. Legacy projects only. |
| Rules (`AGENTS.md`) | The root `AGENTS.md`, else `CLAUDE.md`. Unchanged. |

The full key reference is `../kortix/kortix-yaml.md`.

Legacy: a `kortix_version` 1 or 2 project still uses `harnesses/opencode/`
(or `opencode.config_dir`, or `.kortix/opencode/`) for `opencode.jsonc`,
`plugins/`, `tools/` and `commands/`, and `agents/<name>.md` files.
`kortix migrate` prints the v3 manifest; `kortix migrate --write` writes it.
