---
title: "Kortix vs Flowise: a low-code LLM builder or an open-source platform your team owns"
description: "Flowise was archived in 2026; open-source Kortix is where a team's agents, memory and connectors live in one git repo it owns."
date: "2026-10-13"
canonical: "https://kortix.com/blog/kortix-vs-flowise"
author: "team"
tags: ["Comparisons"]
updated: "2026-10-22"
slug: "/kortix-vs-flowise"
---
Flowise turned an LLM app into a canvas of connected nodes, and Kortix is the open-source AI Operating System a team moves to when that canvas has been archived and nobody upstream is left to maintain it. The teams who built on it face a choice: keep a fork nobody patches, or move the work onto a system the company owns and can maintain. Kortix keeps its projects as git repositories, where the agents are markdown files and the manifest states what each one may reach.

```logos
label: 'Compared here:'
items:
  - { name: Flowise, domain: flowiseai.com }
```

## What Flowise did well

Flowise is an open-source platform for building AI agents and LLM workflows, and its three visual builders (Assistant, Chatflow and Agentflow) covered everything from a first chatbot to multi-agent orchestration ([Flowise docs](https://docs.flowiseai.com/)).

- **It started with a canvas.** You dragged nodes for models, tools and retrieval instead of writing an orchestration layer, so a working RAG chatbot was minutes of clicking ([Flowise docs](https://docs.flowiseai.com/)).
- **The node library was wide.** Flowise connects to 100+ LLMs, embeddings and vector databases and builds on LangChain, so most model and store choices were a dropdown ([Flowise](https://flowiseai.com)).
- **Self-hosting was one command.** `npm install -g flowise` and `npx flowise start` run the whole builder locally, with a Docker Compose path for a server ([Flowise on GitHub](https://github.com/FlowiseAI/Flowise)).
- **A large community formed around it.** Flowise built a substantial open-source following and a library of community templates before the project was archived, and the code stays on GitHub for anyone to fork ([Flowise on GitHub](https://github.com/FlowiseAI/Flowise)).

## The archive makes maintenance the real question

Active development stopped on July 29, 2026. The GitHub repository moved to public archive on August 10, and official end of life came on August 31 ([The Future of Flowise](https://flowiseai.com/sunset)). Issues and pull requests are locked, and the npm package and Docker images are marked deprecated.

Flowise's team gave one reason for the shutdown: the shift toward coding agents. As models got better at reasoning, developers handed complex work to them, and the team says the rigid low-code workflow approach hits its limit when a build gets complicated ([The Future of Flowise](https://flowiseai.com/sunset)). The code stays readable. The core is Apache 2.0, with the enterprise directory under a separate commercial license ([Flowise LICENSE.md](https://github.com/FlowiseAI/Flowise/blob/main/LICENSE.md)).

A team can keep a fork alive, and the license allows it. That fork then carries every security patch and dependency bump itself. Nobody upstream is preparing them.

## A repo your team can read and review

Kortix takes the route a canvas cannot: the system is a repository. `kortix.yaml` sits at the project root. It declares the agents, what each one may reach and the triggers, and the reference calls it the file people write and review by hand ([kortix.yaml reference](https://kortix.com/docs/project/manifest)).

```yaml
kortix_version: 2
default_agent: kortix
agents:
  kortix:
    file: agents/kortix.md
    connectors: all
    secrets: all
    skills: all
```

Behavior lives in `agents/kortix.md`, a markdown file holding the prompt and its frontmatter. The grants, the connectors and the trigger schedule live in the manifest, and a busy project can split triggers into their own YAML files under `triggers/` and import them, so a weekly report is a file a reviewer reads rather than a graph only its author can follow ([kortix.yaml reference](https://kortix.com/docs/project/manifest)).

The manifest gets checked. `kortix validate` runs the same schema check in `kortix ship` and in the change request merge check, and an error blocks the merge. A missing `agents/<name>.md` or a skill with no `SKILL.md` fails there, before it reaches anybody's session ([kortix.yaml reference](https://kortix.com/docs/project/manifest)).

The difference shows up on the day an agent gets a change wrong. One isolated sandbox per session. Each session has its own isolated machine and branch, and the only thing that leaves is what the agent commits to that branch. Session work reaches `main` through a change request, and the merge capability is a grant an admin hands out rather than a default. A fork has no checkpoint of its own, so review is whatever process the team builds around push access.

## What the machine costs

Kortix bills compute and model calls by usage. Nothing is charged per seat. On the Free plan an account pays $0: 500 credits a month, every feature and one project, on your own provider keys or a ChatGPT subscription ([Plans and credits](https://kortix.com/docs/credits)).

The paid plan is credits. You choose a monthly amount, 5,000 credits a month costs $50, and every tier buys credits at 100 credits per dollar ([Kortix pricing](https://kortix.com/pricing)). Members are unlimited and free, the account shares one wallet, and unused monthly credits roll over one month.

Compute is the meter that matters. The default sandbox runs 2 vCPU with 4 GB of memory and 20 GB of disk, and costs about 11 credits an hour, roughly 11 cents for each hour it runs ([Plans and credits](https://kortix.com/docs/credits)). A stopped sandbox accrues nothing. Model calls on your own key cost nothing for the first $1,000 of usage a month, then a 5% fee. Managed models bill at the provider's base price plus a 5.5% platform fee. Run it on Kortix Cloud, in your VPC, or on your own on-prem network. Self-host is free, and a self-hosted instance has no managed models and no credits.

Set that against the fork. The fork's license costs nothing, and its upkeep is a line in somebody's week that never closes: dependency upgrades, security patches, a model provider that renames an endpoint. The meter runs on the machine by the second and on the model calls the work actually makes, and it stops when the machine stops.

## Where Flowise still fits

Flowise did its job well, and for some teams a fork is the right answer. If you already run a Flowise instance and the work is a short, deterministic chain on your own machine, the Apache 2.0 core is yours to keep running, and a canvas still shows that chain at a glance ([The Future of Flowise](https://flowiseai.com/sunset)). The catch is what a fork carries: security patches and dependency drift, with no upstream left to fix them. Flowise also keeps its configuration in its own database and its memory with the flows you build, so it was built for drawing steps, which leaves governing a workforce outside its design ([Flowise docs](https://docs.flowiseai.com/)).

## Kortix and Flowise side by side

```compare
them: Flowise
rows:
  - dimension: Open source
    them: "Yes, Apache 2.0 core"
    kortix: "Yes, self-host or managed cloud"
    lean: both
  - dimension: What it is
    them: "A visual editor for LLM apps and flows"
    kortix: "An AI Operating System agents run on"
  - dimension: Unit of work
    them: "A flow you draw and run"
    kortix: "A session on its own cloud computer"
    lean: kortix
  - dimension: Where configuration lives
    them: "The Flowise database"
    kortix: "Files in a git repo you own"
    lean: kortix
  - dimension: Model choice
    them: "100+ LLMs and vector stores"
    kortix: "Any model, your keys"
    lean: both
  - dimension: Shared memory
    them: "Memory nodes and vector stores"
    kortix: "Company memory files in the repo"
    lean: kortix
  - dimension: Approval of work
    them: "Human-in-the-loop nodes you place"
    kortix: "A change request a person reviews"
    lean: kortix
  - dimension: Self-hosting
    them: "npm or Docker Compose"
    kortix: "Docker Compose, VPC or on-prem"
    lean: both
```

## When to pick which

```verdict
themLabel: Flowise
them: You already run Flowise or a fork of it, and a fixed local flow is all your work needs.
kortix: You want the agents, their skills, company memory and connector rules in one repo you own, every session on its own cloud computer, and session work landing through a change request a person reviews.
```

Next reads: [Kortix vs n8n](/blog/kortix-vs-n8n) makes the same case for fixed workflows, [the self-hosted AI workspace roundup](/blog/best-self-hosted-ai-workspace) compares six platforms by memory and approval, and [how to choose an open-source system you run](/blog/open-source-ai-agent-platform) covers the wider category.

Free to start, free to self-host. [Get started with Kortix](https://kortix.com) and bring one job your team already runs.
