# Agents, subagents and skills on pi

## Agent files

An agent is the same file on both harnesses: `agents/<name>.md`, named by
`agents.<name>.file` in `kortix.yaml`. The frontmatter holds the behavior and
the body is the system prompt. The manifest entry holds what the agent may
access (`../kortix/kortix-yaml.md`).

```markdown
---
description: "Reviews one change and reports problems."
mode: subagent
permission:
  edit: deny
  bash:
    "git diff *": allow
    "*": ask
---

You review one change. Report each problem with its file and line.
```

pi applies these frontmatter fields:

| Field | Effect on pi |
| --- | --- |
| body | The system prompt. |
| `description` | Shown to the agent that delegates with `task`. |
| `mode` | `primary`, `subagent` or `all`. `subagent` and `all` make the agent a `task` target. |
| `model`, `variant` | The model and its reasoning tier. The session's own model choice wins. |
| `temperature`, `top_p`, `steps` | Sampling and the maximum number of model steps in a turn. |
| `tools` | `{ <tool>: false }` removes a built-in tool. |
| `permission` | The permission rules (`tools.md` → Permissions). |

pi does not apply `options` (provider options).

The manifest `skills:` grant of the agent decides which skills it sees. A
skill outside the grant is absent from the system prompt.

## Subagents

The `task` tool runs one prompt in a child session and returns its final
message. Arguments: `description`, `prompt`, `subagent_type`, and `task_id`
to continue an earlier child.

| `subagent_type` | What it is |
| --- | --- |
| `general` | All tools except `question` and `task`. |
| `explore` | Read-only: `bash`, `read`, `glob`, `grep`. |
| `<agent name>` | Each project agent with `mode: subagent` or `mode: all`, with its own prompt, model and `permission`. |

- A subagent cannot start another subagent.
- A subagent cannot ask the user a question.
- Several `task` calls in one message run at the same time.
- The user sees each child session in the product, as with OpenCode.

## Skills

pi has no `skill` tool. The system prompt lists each skill the agent may use,
with its description and the path of its `SKILL.md`. The agent reads the file
with `read` when the description matches the task.

pi loads skills from these directories. The first skill of a name wins:

1. the managed `kortix-*` skills, which the platform keeps current;
2. `skills/` at the repository root;
3. `skills/` in the pi config directory (`harnesses/pi/skills/`);
4. `.kortix/opencode/skills/` (legacy projects).

A prompt that starts with `/skill:<name>` loads that skill into the turn.

The authoring rules are the same on both harnesses
(`../authoring-skills.md`).
