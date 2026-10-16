# Agents, subagents and skills on pi

## Agents

An agent is the same on both harnesses: one block under `agents` in
`kortix.yaml` (`kortix_version: 3`). The block holds the prompt, the
behavior and the grants (`../kortix/kortix-yaml.md`). There is no agent file
and no pi agent directory.

```yaml
agents:
  reviewer:
    description: Reviews one change and reports problems.
    mode: subagent
    prompt: You review one change. Report each problem with its file and line.
    permission:
      edit: deny
      bash:
        "git diff *": allow
        "*": ask
    skills: [code-review]
```

pi applies these keys:

| Key | Effect on pi |
| --- | --- |
| `prompt` or `prompt_file` | The system prompt. |
| `description` | Shown to the agent that delegates with `task`. |
| `mode` | `primary`, `subagent` or `all` (default). `subagent` and `all` make the agent a `task` target. |
| `model`, `variant` | The model and its reasoning tier. The session's own model choice wins. |
| `temperature`, `top_p`, `steps` | Sampling and the maximum number of model steps in a turn. |
| `tools` | `all`, `none`, a list, or `{ exclude: [names] }`. |
| `permission` | The permission rules (`tools.md` → Permissions). Omitted: `allow`. |
| `skills`, `subagents` | Compile to `permission.skill` and `permission.task` allowlists. |
| `extensions` | The pi packages a session of this agent loads (`extensions.md`). |
| `codemode` | `on` (default), `only` or `off`: pi's `codemode` tool. |

pi does not apply `options` (provider options) or `color`.

## Subagents

The `task` tool runs one prompt in a child session and returns its final
message. Arguments: `description`, `prompt`, `subagent_type`, and `task_id`
to continue an earlier child.

`subagent_type` is a declared agent that the calling agent's `subagents`
grant lists. Each one is another agent with `mode: subagent` or `all`, with
its own prompt, model and `permission`. A v3 project has no built-in
`general` or `explore` subagent.

- A subagent cannot start another subagent.
- A subagent cannot ask the user a question.
- Several `task` calls in one message run at the same time.
- The user sees each child session in the product, as with OpenCode.

## Skills

pi has no `skill` tool. The system prompt lists each skill the agent may use,
with its description and the path of its `SKILL.md`. The agent reads the file
with `read` when the description matches the task.

pi loads exactly two sets of skills: the managed `kortix-*` skills, and the
skills that `kortix.yaml` registers under `skills:` (name → folder). The
agent's `skills` grant decides which of them it sees. Omitted, it sees none.
A `SKILL.md` that no registry entry names is never visible.

A prompt that starts with `/skill:<name>` loads that skill into the turn.

The authoring rules are the same on both harnesses
(`../authoring-skills.md`).

Legacy: a `kortix_version` 1 or 2 project still reads `agents/<name>.md`
files and skill folders, and pi still offers `general` and `explore` there.
`kortix migrate` prints the v3 manifest; `kortix migrate --write` writes it.
