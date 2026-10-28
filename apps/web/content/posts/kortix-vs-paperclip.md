---
title: "Kortix vs Paperclip: an open-source company system or a control plane for your agents?"
description: "Paperclip coordinates the agents you run; Kortix is the open-source system that runs them too, each session on its own cloud computer."
date: "2026-10-13"
canonical: "https://kortix.com/blog/kortix-vs-paperclip"
author: "team"
tags: ["Comparisons"]
updated: "2026-10-25"
slug: "/kortix-vs-paperclip"
---
Paperclip is an open-source control plane for a team of AI agents you already run, and Kortix is the open-source AI Operating System that runs them too. Paperclip hands those agents an org chart, a task board and a budget you set per agent, then runs each agent's own CLI on the Paperclip host unless you attach an environment. Kortix takes the same ambition one layer down, hosting the agents, giving each session its own cloud computer, and landing the work as a change request a person reviews. The choice is how much of the stack you want the software to carry.

```logos
label: 'Compared here:'
items:
  - { name: Paperclip, domain: paperclip.ing }
```

## What Paperclip gets right

Paperclip is a Node.js server and a React UI that orchestrates AI agents into one organization. Paperclip's own framing: if OpenClaw is an employee, Paperclip is the company ([Paperclip on GitHub](https://github.com/paperclipai/paperclip), checked October 2026). The idea holds up, and so does the build.

- **It meets your agents where they are.** Bring Claude Code, Codex, Cursor, Gemini CLI, OpenCode, Hermes, Grok Build or Kimi Code, or any HTTP endpoint that can receive a heartbeat.
- **It gives the team a shape.** Agents get roles, titles and reporting lines, and delegation runs up and down a mixed human and agent org chart. Hiring can be gated by board approval, a per-company policy you turn on.
- **Budgets stop spend.** Set a monthly budget per agent and Paperclip warns at 80% and auto-pauses the agent at 100%, until you raise the cap or the month resets ([cost controls](https://docs.paperclip.ing/guides/day-to-day/costs/), checked October 2026).
- **Every change lands on the record.** Task, agent, approval, budget and company events all land in the activity log, with run history and tool-call tracing alongside ([activity log](https://docs.paperclip.ing/guides/day-to-day/activity-log/), checked October 2026).
- **It installs in one command.** `npx paperclipai@latest onboard --yes` starts the UI and API on an embedded Postgres, the Docker image runs a persistent server, and no Paperclip account is needed. The code is MIT-licensed.

Skill Studio gives the team shared skills with version history.

## A control plane still needs a runtime

Paperclip coordinates agents, and by default it runs an agent's own CLI on the Paperclip host. The model and the harness stay with whoever built the agent. The machine is the host too unless you attach an environment: an SSH box or a sandbox plugin such as [Cloudflare or Daytona](https://docs.paperclip.ing/reference/adapters/sandbox-providers/), assigned per instance, project or agent ([environments](https://docs.paperclip.ing/experimental/environments/), checked October 2026). Paperclip's FAQ is explicit: your agents are your own, and you secure them however you want to. The design is coherent.

Sandboxing is where the boundary shows. Paperclip's docs describe an isolated workspace as a git worktree on its own branch, and it takes both an experimental instance flag and a per-project opt-in. With either off, every task run works in the project's primary checkout ([isolated workspaces](https://docs.paperclip.ing/experimental/isolated-workspaces/), checked October 2026). Paperclip's unit of work is a ticket with an owner, a status and a thread, and review stages live inside that ticket.

The hard stop is real, with one caveat: enforcement reads recorded spend, so a stop can trail work in flight. A control plane hands execution to somebody else on purpose, and Paperclip does that well.

## The company as a repository

Kortix makes the repository the company. Agents, skills, company memory, connector configuration and triggers are files in one git repo you own. A `kortix.yaml` at the root declares how a session boots, and its trigger keys follow the [triggers reference](https://kortix.com/markdown/docs/connect/triggers.md) ([Kortix docs](https://kortix.com/docs)).

```yaml
kortix_version: 2
default_agent: ops-morning
agents:
  ops-morning:
    file: agents/ops-morning.md
    connectors: [kortix_slack, stripe]
connectors:
  - slug: stripe
    provider: composio
    app: stripe
triggers:
  - slug: morning-brief
    type: cron
    agent: ops-morning
    cron: "0 0 9 * * 1-5"
    prompt: Write the morning brief from yesterday's Stripe and Slack activity.
```

That file is the whole governance layer for one agent. It lists the connectors that agent may call, the cron that wakes it on weekday mornings, and the default a bare session falls back to. The prompt sits next door in `agents/ops-morning.md`. `kortix validate` runs the same schema check in `kortix ship` and in the merge check, so a broken manifest fails before either.

Paperclip has moved toward this ground. An export is a package of markdown files that diffs cleanly in git. `paperclipai company import` accepts a GitHub URL with a `--ref` ([export and import](https://docs.paperclip.ing/guides/power/export-import/), checked October 2026). The live copy is still the database. Approvals, cost history and activity log entries stay behind in an export, and an import previews its changes before applying them. In Kortix the repo is the live copy, so the diff you review is the change that takes effect.

- **Grep the whole company.** Agents and skills are Markdown, memory is files, connectors and triggers are config. Version a change, read the diff, roll one part back.
- **Start from anywhere.** Web, desktop, mobile, CLI, TUI, the MCP server, or a live Slack, Teams or email channel.
- **Every tool in the same repo.** 3,000+ apps in a click, plus MCP, OpenAPI, Postman, GraphQL and raw HTTP. Connector credentials are brokered server-side and never enter the machine, and each action is set to allow, ask or block.

## One computer per session, one gate before main

Every Kortix session boots its own isolated machine, clones the project onto a branch named after the session, and commits there. A project can run many sessions at once, with no crossover between them. Paperclip hands the run to your host. Kortix gives every session its own machine by default, with no plugin and no flag, and the machine stops when the session does.

That isolation sets up the unit of work. Session work reaches `main` through a change request, and merge is default-deny for agents: a session merges only when its agent's `kortix_permissions` grant includes `project.gitops.merge`. The starter agent ships with `all`, so narrow the grant if you want a person on every merge. A ticket in a dashboard governs a task. A change request governs a diff against the repository the company runs from.

Triggers widen what reaches that gate. A weekday cron starts a session with nobody at a keyboard. A connector call runs, waits for a person or is blocked per action, and the decision is recorded. Paperclip's approvals cover a task and a tool call. Kortix's cover the diff.

## What running the work costs

Paperclip never pays for the machine, so its ledger tracks what your providers bill, per agent. Kortix pays for the machine and bills it directly. The default 2 vCPU, 4 GB, 20 GB computer costs about 11 credits an hour, charged per second, and nothing while it is stopped ([plans and credits](https://kortix.com/docs/credits)).

- **Free is $0.** 500 credits a month, every feature, one project, on your own provider keys or a ChatGPT subscription. Those credits cover the default machine.
- **The Credits plan buys compute and managed models.** You choose a monthly amount and every tier buys 100 credits per dollar, so 5,000 credits is $50 a month. Members are unlimited and free, the account shares one wallet, and unused monthly credits roll over one month ([Kortix pricing](https://kortix.com/pricing), checked October 2026).
- **Self-hosting is free.** The same stack on your infrastructure, with no managed models and no credits to buy.

The two bills answer different questions. Paperclip's tells you what each agent spent at the provider. Kortix's tells you what the work cost to run, and a stopped computer costs nothing. A team already paying agent subscriptions will find Paperclip's numbers closer to its invoice.

## Where Paperclip wins

If your team already runs Claude Code or Codex across several vendors and the problem is which of twenty terminals is doing what, Paperclip is the better start. The org chart, per-agent budgets with automatic pauses, board approvals and the activity log across task, agent, approval, budget and company events are built for that job. Paperclip ships agent training and saved evals that Kortix does not. Buy it for the fleet you already operate.

## Side by side

```compare
them: Paperclip
rows:
  - dimension: Open source
    them: Yes, MIT
    kortix: Yes, self-host or cloud
    lean: both
  - dimension: Where agents run
    them: Your runtime; sandboxing optional
    kortix: One isolated computer per session
    lean: kortix
  - dimension: Where the company lives
    them: Its database, exported as packages
    kortix: A git repo you own
    lean: kortix
  - dimension: How work lands
    them: Tickets and approvals in the dashboard
    kortix: A change request read as a diff
    lean: kortix
  - dimension: Per-agent budgets
    them: Company, agent and project limits
    kortix: Credits per account, metered by the second
    lean: them
  - dimension: Native org chart
    them: Human and agent roles with reporting lines
    kortix: Roles, groups and per-resource permissions
    lean: them
  - dimension: Models and harnesses
    them: Any model, any harness, per agent
    kortix: Any model with your keys, per agent
    lean: both
  - dimension: Self-host
    them: Yes, local or Docker
    kortix: Yes, VPC or on-prem, free
    lean: both
```

## When to pick which

```verdict
themLabel: Paperclip
them: You already run agents from several vendors and want one org chart, budgets and a task board over them.
kortix: You want the platform to run the agents too, from a repo that holds the agents, skills, memory and connectors.
```

Paperclip is the stronger pick for governing a fleet you already operate, and its budget controls are far more granular. Kortix is the one to run when the company's definition should live in a repository you own and every session's work should reach `main` through a change request. Both are open source, so the decision is about how much of the stack the software carries.

The nearest runtime comparison is [Kortix vs OpenHands](/blog/kortix-vs-openhands), and [choosing an open-source system that runs the work](/blog/open-source-ai-agent-platform) covers the wider field.

Free to start, free to self-host. Start with [Kortix](https://kortix.com).
