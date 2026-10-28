---
title: "Kortix vs OpenHands: replace the open-source harness, keep the open-source record"
description: "OpenHands is a strong open-source coding harness; Kortix is the open-source AI Operating System that keeps the record of who let an agent do what."
date: "2026-10-04"
canonical: "https://kortix.com/blog/kortix-vs-openhands"
author: "team"
tags: ["Comparisons"]
updated: "2026-10-21"
slug: "/kortix-vs-openhands"
---
OpenHands is a strong open-source coding harness; Kortix, which we build, is the open-source AI Operating System for the layer underneath it, the record of who let an agent do what. OpenHands' own product page makes the case that the harness is the replaceable part: Agent Canvas drives Claude Code, Codex, Gemini CLI or the built-in OpenHands agent from one screen ([OpenHands](https://openhands.dev/), checked October 2026). The question a company has to answer sits under that screen. When the harness changes, what stays in your hands?

```logos
label: 'Compared here:'
items:
  - { name: OpenHands, domain: openhands.dev }
```

## What OpenHands gets right

OpenHands is a coding harness built with care. It has earned the recommendation engineering teams give it.

- **It runs the agents you already chose.** Agent Canvas switches between the built-in OpenHands agent, Claude Code, Codex, Gemini CLI and your own stack. The backend is one dropdown. That is a harness doing its job. The agent is a choice you can swap next month.
- **The runtime is a sandbox per conversation.** The Docker runtime builds an image from the base image you supply and runs shell, file and Python actions inside it. Observations come back to the agent backend ([runtime architecture](https://docs.openhands.dev/openhands/usage/architecture/runtime), checked October 2026).
- **Self-hosting has real routes.** A laptop, Docker on a VM, or a Kubernetes cluster you operate. The Enterprise install ships Helm charts, Keycloak for identity, and Postgres plus an object store for conversation state ([enterprise architecture](https://docs.openhands.dev/enterprise/architecture), checked October 2026).
- **Model choice includes open weights.** OpenHands runs closed models and open-weight ones such as Kimi, DeepSeek and Qwen. Either can run locally, in the cloud, or inside your VPC.
- **Automations start where engineers already work.** GitHub, GitLab, Slack, Jira, Linear and schedules can all open a conversation. That is the shape of a software team's day.
- **It releases quickly.** v1.29.0 shipped in October 2026 ([releases](https://github.com/OpenHands/OpenHands/releases), checked October 2026).

## Where a harness runs out of road

A harness is built to get an agent through a task in a repository, and OpenHands does it with more care than most. Its limits appear when the question moves from the run to the company.

- **Identity is a tier, not a default.** The free Agent Canvas runs as a single shared identity. User identity and RBAC, SAML SSO and budgeting are listed from Teams up. Teams costs $499 a month for up to 10 seats, adds $50 a month per seat, and caps at 5,000 sessions a month ([pricing](https://openhands.dev/pricing), checked October 2026). The record of who ran what arrives with a plan, inside the product's admin console.
- **An agent's definition lives in the product.** Skills load from a repo's `.openhands/skills/` or from a sandbox home directory ([upload skills](https://docs.openhands.dev/cookbook/upload-skills), checked October 2026). Agent profiles are built in the app from a server catalog ([v1.29.0 notes](https://github.com/OpenHands/OpenHands/releases)). Both work. So the definition of an agent and the diff of a change to it sit in two places, and one of them is not a repository.
- **The record of a run is conversation state.** Conversations persist to Postgres, Redis and an object store, and you read them back in the app.
- **The work is software.** Issues in, pull requests out. The design stops where the repository does.

## The record is the part you cannot swap

A team can change its coding harness in a quarter. Unplug one, plug in the next, keep the repositories. What is expensive to rebuild is the trail of what each agent was allowed to touch, who approved that, and what changed last Tuesday. A transcript answers the last of those, for one conversation, inside one product.

We run Kortix on itself in public, which makes our argument checkable. Over the past month, `Kortix Agent` authored about two in five of the first-parent commits that landed on the trunk of [Kortix on GitHub](https://github.com/kortix-ai/suna). The rest came from release bots and from people. Anyone can reproduce the count from the public repository:

```bash
git log --first-parent --since="one month ago" --format=%an \
  | sort | uniq -c | sort -rn
```

One of those merges was [PR #10587](https://github.com/kortix-ai/suna/pull/10587), `fix(api): revoke credentials on deletion confirmation (KRTX-2919)`, merged in October 2026: two commits and a small diff. The diff names the author, and the merge carries a timestamp anyone can read. What matters is the trail. Four months of agent work sits in the same history as the code it changed, so a reviewer can ask who gave the agent a credential and find an answer.

## What stays in the repo

We treat the company as the codebase. An agent is `agents/<name>.md` plus its `agents.<name>` block in `kortix.yaml`. Skills are Markdown plus scripts, and memory is files. A change to what an agent may reach arrives as a diff a colleague reviews, and a new session reads your own files instead of starting from an empty context.

- **Work reaches the trunk through review.** Session work reaches `main` through a change request. Merge is default-deny for agents.
- **Permissions cover people and agents.** Per-resource permissions for people and agents. Roles, groups, and an audit trail.
- **Scheduled work takes the same road.** A trigger is a cron schedule or a signed webhook, and the session it starts lands through the same change request as a person's.

Price works the other way round. We bill the machine, not the headcount. Free is $0 with 500 credits per month and 1 project, on your own provider keys or ChatGPT subscription. The paid plan is credits: tiers from $50 a month, and the account shares one credit pool ([pricing](https://kortix.com/pricing), checked October 2026). The models we manage, open-weight DeepSeek and GLM, run on the Credits plan or Enterprise, with zero data retention ([models](https://kortix.com/docs/project/models), checked October 2026).

## Where OpenHands is the better answer

Pick OpenHands when the work is code and the buyers are engineers. It is free to self-host on your own hardware. The core is MIT-licensed, and it runs whichever agent your team already trusts. The release pace is fast: seven tagged releases in October 2026. Its Large Codebase SDK maps dependencies across a big codebase and orders changes so several agents can work without colliding ([OpenHands](https://openhands.dev/)). That is a deeper engineering answer than a general agent runtime gives.

A team that wants a self-hosted control center for coding agents, and nothing beyond that, should start with OpenHands and stop there. We ask you to treat the whole company as a codebase, which is more than a software team needs on day one.

## Side by side

```compare
them: OpenHands
rows:
  - dimension: Open source
    them: 'Yes, MIT-licensed core'
    kortix: 'Yes, self-host or managed cloud'
    lean: both
  - dimension: Where agents run
    them: 'Local host, Docker, VM or your cluster'
    kortix: 'Cloud, your VPC or on-prem; one sandbox per session'
    lean: kortix
  - dimension: Model choice
    them: 'Any LLM, own keys or local weights'
    kortix: 'Provider keys, ChatGPT plan, or managed credits'
    lean: both
  - dimension: The record it keeps
    them: Conversation state in its own database
    kortix: 'Agents and grants in a git repo, plus audit trail'
    lean: kortix
  - dimension: Human review
    them: Pull requests on code
    kortix: Change request a person approves before merge
    lean: kortix
  - dimension: Team controls
    them: 'RBAC, SSO, budgets from the Teams plan'
    kortix: Per-resource permissions for people and agents
    lean: both
  - dimension: The work it runs
    them: 'Code end to end: repos, terminals, tests, PRs'
    kortix: 'Any team''s work; coding is one job'
    lean: them
  - dimension: Price shape
    them: 'Free to self-host; $499 a month for 10 seats'
    kortix: 'Free tier; credits from $50 a month'
    lean: both
```

## When to pick which

```verdict
themLabel: OpenHands
them: You need a free, self-hosted harness that runs coding agents on your repositories, and the review gate you want is a pull request.
kortix: You need one place that records who let an agent do what, across every department, in a repo your company owns.
```

For a team comparing coding workspaces rather than whole companies, [Kortix vs Nimbalyst](/blog/kortix-vs-nimbalyst) covers that ground. For the review gate across five open-source systems, read [what separates the open-source options](/blog/open-source-ai-agent-platform).

```cta
title: Own the record, not just the run.
body: Free to start, free to self-host.
```
