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

The `agent` tool (`task` is its deprecated alias) runs one prompt in a child
session and returns its final message. Arguments: `description`, `prompt`,
`subagent_type` (or an inline `agent` spec), `task_id` to continue an earlier
child, and `session`:

| `session` | Where the subagent runs | Use it for |
| --- | --- | --- |
| `separate` (default) | Its own new Kortix session and computer, linked to this session, visible in the sidebar, still running after your turn. | Real tasks, long or parallel work, a whole job handed to another agent. |
| `same` | Inside this session, on this computer. Instant, no extra computer. | Quick lookups and small sub-steps. |

When a separate session is not possible (the project turned the setting
"Separate subagent sessions" off, or the session has no control plane), the
call runs in this session and the result says so. A `task_id` continues the
child where it was created.

| `subagent_type` | What it is |
| --- | --- |
| `general` | All tools except `question` and `task`. |
| `explore` | Read-only: `bash`, `read`, `glob`, `grep`. |
| `<agent name>` | Each project agent with `mode: subagent` or `mode: all`, with its own prompt, model and `permission`. |

- A `same` subagent cannot start another subagent. A `separate` subagent can,
  up to 2 levels deep.
- At most 4 separate subagents of one session run at once.
- A subagent cannot ask the user a question.
- Several `agent` calls in one message run at the same time.
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
