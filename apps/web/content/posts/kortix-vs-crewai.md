---
title: "Kortix vs CrewAI: the framework is free, the runtime is open source"
description: "CrewAI gives you a free Python framework for agent teams, while open-source Kortix ships the runtime around it: grants, sandboxes, and review."
date: "2026-10-13"
canonical: "https://kortix.com/blog/kortix-vs-crewai"
author: "team"
tags: ["Comparisons"]
updated: "2026-10-22"
slug: "/kortix-vs-crewai"
---
CrewAI is a strong open-source Python framework for role-based agent teams, and Kortix is the open-source AI Operating System that ships the runtime a framework leaves to you. The library costs nothing and a first crew takes an afternoon. What it does not decide is who an agent may call, where memory lives once the process exits, or who signs off before the work reaches production. Those answers are the runtime, and the runtime is the part you choose.

```logos
label: 'Compared here:'
items:
  - { name: CrewAI, domain: crewai.com }
```

## What CrewAI hands you

CrewAI is an open-source Python framework for role-based agents, built on two primitives. Crews are teams of agents with roles, goals, and delegation between them. Flows are event-driven workflows with explicit control of branching and state, and a Flow can call a Crew partway through ([CrewAI on GitHub](https://github.com/crewAIInc/crewAI), checked October 2026).

The install is short. CrewAI runs on Python 3.10 or later, below 3.14, and goes in with `uv tool install crewai` ([installation](https://docs.crewai.com/en/installation), checked October 2026). Then `crewai create crew` writes a project and `crewai run` loads it.

A task takes a `human_input` flag, off by default, described as "whether the task should have a human review the final answer of the agent" ([tasks](https://docs.crewai.com/en/concepts/tasks), checked October 2026). One `Memory` class carries hierarchical scopes, slices, consolidation, and LLM-assisted recall. The default store is LanceDB under `./.crewai/memory`, unless you pass another path or backend ([memory](https://docs.crewai.com/en/concepts/memory), checked October 2026).

CrewAI also sells the layer around the library. AMP is a commercial agent management platform: it deploys and governs Crews with agent tracing and controls, on any LLM or deployment mode ([AMP](https://crewai.com/agent-management-platform), checked October 2026). Enterprise puts it on CrewAI cloud, your own VPC, or your own infrastructure. Basic is free with 50 workflow executions a month, and Enterprise is custom priced ([pricing](https://crewai.com/pricing), checked October 2026).

## The half a library leaves to you

- **Who may call what.** CrewAI limits the tools an agent may use inside the process you deploy. Provider keys and tool credentials arrive as environment values in the application your team runs, so the boundary is the one your application already has.
- **What persists.** Memory is durable, in a vector store under a path your application keeps, backs up, and migrates. In Kortix your agents, their skills, your company memory, and every connector sit in one git repo as text, so a memory change is a commit that can be read, blamed, and reverted.
- **Who signs off.** `human_input` pauses one task and asks a person to read an answer, and the place that question appears is your application. In Kortix the same question arrives with the diff attached: session work reaches `main` through a change request, and merge is default-deny for agents.

None of it is a flaw in CrewAI, which was never asked to hold permissions or an approval trail. The runtime is the fourth item, and the expensive one: the process you deploy and restart, plus the permissions, memory and review queue it holds for a company.

## Grants are a file, and the merge is where they get checked

In the starter project's manifest, one agent's governance is five lines:

```yaml
agents:
  kortix:
    file: agents/kortix.md
    connectors: all
    secrets: all
    kortix_permissions: all
    skills: all
```

Those grants are deliberately wide. The file says so, and tells you to narrow them once you know what the project needs. Grants are deny-by-default: an agent with no `connectors`, `secrets`, `apps` or `kortix_permissions` key gets none of them. Two keys differ. An omitted `skills` falls back to the agent's own permission rules, and an omitted `tools` grants every tool ([agents and permissions](https://kortix.com/docs/project/agents), checked October 2026). So a new agent arrives holding every tool, until somebody narrows it. The block above is `packages/starter/templates/base/kortix.yaml` on [Kortix on GitHub](https://github.com/kortix-ai/suna/blob/dev/packages/starter/templates/base/kortix.yaml).

A change request merges a session's branch into its base branch. For a config edit that ordering is the point: a session runs the config release of its base branch, not the files in its own working copy, so the edit takes effect when the merge lands. The change request is where a second person reads the edit first. Kortix validates `kortix.yaml` on the head branch first: an invalid manifest stops the merge with `422 MANIFEST_INVALID`. A merge that changes `agents` or `default_agent` also needs `project.agent.write`. A merge that adds, changes, or removes a trigger needs `project.trigger.create`, `project.trigger.update`, or `project.trigger.delete`. A session also cannot merge a change request it opened unless its grant includes `project.gitops.merge`. Without that, the merge returns `403` `CR_SELF_MERGE_REFUSED` ([git and change requests](https://kortix.com/docs/git), checked October 2026).

One merged change request from the starter repo shows what that looks like. Change request 9873, merged in October 2026, is a two-file diff. It adds two comment lines to the starter `kortix.yaml`, naming the `workspace:` switch a new project starts with. The embedded snapshot the starter ships is regenerated in the same change ([Kortix on GitHub](https://github.com/kortix-ai/suna/pull/9873)).

On a v2 manifest you can also set grants from the dashboard's agent editor or with `kortix agents scope`. Both commit `kortix.yaml` straight to the default branch and need `project.agent.write`, with no change request in between ([agents and permissions](https://kortix.com/docs/project/agents), checked October 2026). Either path leaves a commit in the repo. The change-request path also leaves the diff and the approval beside it, which is the part a second person can read a year later.

## One sandbox per session, and the credentials that stay outside it

Kortix starts a sandbox for each session and stops it when the session ends. The branch is named after the session id with no prefix, and a session pushes only that branch unless someone widens its grant. Two people working at once never share a working copy, and neither of them shares one with the agent. The isolation is one line on the security page: "One isolated sandbox per session" ([Kortix security](https://kortix.com/security)).

A CrewAI deployment is a process your team runs, so concurrency means Python workers and isolation means whatever your platform gives a worker, and that worker keeps running between tasks.

Connectors are how that sandbox reaches the rest of the company, and connector credentials never enter the machine: they are brokered server-side ([Kortix](https://kortix.com/)). A secret you grant is another matter. It arrives as an environment value in the session, readable by any command the agent runs.

## What the other half costs

CrewAI charges nothing for the framework. Kortix prices the sandbox a session runs on and sells it in credits: "It bills per second while it runs and costs nothing while it is stopped." Free is $0 with 500 credits per month, every feature and 1 project, on the user's own provider keys or ChatGPT subscription. Managed models are on the Credits plan only. Credits sell at one rate, 100 credits per dollar, so 5,000 credits a month costs $50. Members are unlimited and free, and the account shares one credit pool ([pricing](https://kortix.com/pricing), checked October 2026).

Hosting is separate from that. Run it on Kortix Cloud, in your VPC, or on your own on-prem network. Self-host is free. The same repository runs in all three places, and the code that reads the grants and starts the sandboxes sits in it. The runtime is yours to read.

## Where CrewAI is the better pick

If the agents live inside an application your engineers own, CrewAI is better and we would say so. Its primitives are compact, the scaffolding is quick, and the memory subsystem is more than most teams would build. A team with Python services and a deploy pipeline it trusts should keep the runtime it has. Buying AMP is a fair third option for a team that wants the control plane without the maintenance.

One application, one engineering team, no need for per-resource permissions or a signed-off diff: the framework is enough.

## Side by side

```compare
them: CrewAI
rows:
  - dimension: Open source
    them: 'Yes, an MIT-licensed Python framework'
    kortix: 'Yes, and the platform around it'
    lean: both
  - dimension: Time to a first agent
    them: 'An afternoon: uv tool install crewai'
    kortix: 'A project, a repo, and a first session'
    lean: them
  - dimension: Who runs the runtime
    them: Your application process
    kortix: A sandbox per session
  - dimension: Where config lives
    them: Python code and project files
    kortix: 'kortix.yaml and agents/<name>.md'
  - dimension: Human review
    them: A `human_input` flag on a task
    kortix: A change request; merge needs a grant
    lean: kortix
  - dimension: Reach outside the app
    them: A tools library you wire in
    kortix: '3,000+ apps in a click, plus MCP and raw HTTP'
    lean: kortix
  - dimension: Managed layer
    them: 'AMP Suite on CrewAI cloud, your VPC, own infrastructure'
    kortix: 'Kortix Cloud, or self-host for free'
    lean: both
  - dimension: Price shape
    them: 'Framework free; hosted tier per execution'
    kortix: 'Free tier; credits from $50 a month'
```

## When to pick which

```verdict
themLabel: CrewAI
them: You want agents inside a Python application your team deploys and monitors.
kortix: You want agents working across a company, on sandboxes you can see, with grants and merges you review.
```

If you are still weighing the category, [Kortix vs LangGraph](/blog/kortix-vs-langgraph) covers the graph-shaped end of it, and [the review gate that separates open-source systems](/blog/open-source-ai-agent-platform) covers the rest.

```cta
title: Don't just pick a runtime. Read it.
body: Free to start, free to self-host.
```
