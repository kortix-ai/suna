---
title: "Kortix vs Onyx: open-source search, or the open-source system that runs the work?"
description: "Onyx is open-source, self-hostable enterprise search; Kortix is open source and runs governed agents that do the work search only surfaces."
date: "2026-10-13"
slug: "/kortix-vs-onyx"
canonical: "https://kortix.com/blog/kortix-vs-onyx"
author: "team"
tags: ["Comparisons"]
---
Canonical: https://kortix.com/blog/kortix-vs-onyx

Onyx is an open-source, self-hostable search layer for a company's knowledge, and Kortix is the open-source AI Operating System that runs the work that search surfaces. Both index what your team knows and both run on infrastructure you control. The difference is what happens after a search result appears, when someone has to act on it.

```logos
label: 'Compared here:'
items:
  - { name: Onyx, domain: onyx.app }
```

## What Onyx gets right

Onyx, the project formerly called Danswer, is a serious retrieval product. Most of what a team wants from search over its own knowledge, it already does.

- **It is open source and you can self-host it.** The Community Edition ships under the MIT license and covers RAG, chat, agents and actions; the Enterprise Edition adds features for larger organizations. Its latest release is v4.9.0, dated October 2026 (checked October 2026). ([Onyx on GitHub](https://github.com/onyx-dot-app/onyx))
- **Search respects your permissions.** Onyx syncs access control lists from the source systems and enforces them at query time, so a person only sees answers sourced from documents they can already open.
- **40+ connectors, indexed in the background.** OAuth or an API key, no code to write, and permission sync from Confluence, Jira, GitHub, Google Drive, Gmail, Slack, Salesforce and SharePoint. ([Onyx connectors](https://onyx.app/connectors))
- **Agents on top of the index.** You can build agents with a subset of knowledge, custom instructions and actions through MCP or OpenAPI, plus a sandbox for code and generated artifacts.
- **Deployment on your terms.** Self-host the open-source build, self-host the Enterprise Edition, or use Onyx Cloud, sold at $20 per user per month on annual billing with Enterprise on a custom contract; the docs describe a two-week managed trial. ([Onyx pricing](https://onyx.app/pricing), [deployment docs](https://docs.onyx.app/deployment/overview))

## Where a search layer stops

Onyx's center of gravity is the index. It finds and answers, and the work that follows a good answer happens somewhere else.

- **The product is retrieval.** Onyx is built to put the right document in front of a person or a model, fast and cheaply. Its agents retrieve and reason over that context; they do not run a queue of jobs across the company.
- **Actions are per-call wiring.** Making an agent take a real action means adding an MCP or OpenAPI action and the retrieval that feeds it. No machine stands up for one task, finishes the job and hands back a reviewed change.
- **Configuration lives in a product.** Connectors, agents and permissions are set in a deployed instance and its admin console. You operate a running app, and there is no single diff to review, branch to cut or repo to fork.
- **There is no merge gate for the work.** A cross-department job runs through a chat and its actions. Nothing collects the result as a change request that a person reads before it lands.

A search product is not expected to close the ticket. Those four limits only bite once the job changes from finding the answer to acting on it.

## What Kortix does differently

Kortix takes the same request and runs it as a job, with agents on machines they hold for the length of the task.

- **One repo is the operating layer.** Agents, skills, company memory, connectors and triggers are files in one git repo you own, as the [Kortix docs](/docs) describe. `kortix.yaml` declares the machine image, the connectors and the triggers, so nothing about how the company works hides in a vendor database.
- **Every session gets its own cloud computer.** One isolated sandbox per session, each on its own branch. Thousands of agents run in parallel on one config, each on its own cloud computer.
- **3,000+ apps through scoped connectors.** 3,000+ apps in a click, plus MCP, OpenAPI, Postman, GraphQL and raw HTTP. Connector credentials are brokered server-side and never enter the machine.
- **Merge is default-deny for agents.** Session work reaches `main` through a change request, so a person reads the diff before it lands.
- **Any model, your keys, your infrastructure.** Bring any model provider with your own keys, or the ChatGPT plan you already pay for. Run it on Kortix Cloud, in your VPC, or on your own on-prem network; self-host is free.

An agent and a trigger are ordinary files in the repo:

```yaml
# kortix.yaml: the company as files
agents:
  support-triage:
    file: agents/support-triage.md
    connectors: all
triggers:
  - slug: daily-digest
    type: cron
    cron: '0 0 9 * * 1-5'
    prompt: Summarize yesterday's tickets and open a change request.
```

## Where Onyx is the stronger pick

If the whole job is index and answer over connected apps, Onyx does it and Kortix does not. Onyx documents a fully air-gapped deployment with no external third parties, the strictest posture a self-hosted product can offer. Kortix runs on-prem, and it is not air-gapped. A team whose only need is a private search layer over its own documents should pick Onyx and stop there.

## Side by side

```compare
them: Onyx
rows:
  - dimension: Open source
    them: Yes, MIT Community Edition
    kortix: Yes, read it, fork it, audit it
    lean: both
  - dimension: Core job
    them: Index and answer over company knowledge
    kortix: Run agents that do the work
    lean: both
  - dimension: Where the config lives
    them: In a deployed instance you operate
    kortix: Files in one git repo you own
    lean: kortix
  - dimension: A machine per task
    them: A sandbox for agent code
    kortix: One cloud computer per session
    lean: both
  - dimension: Parallel agents
    them: Not published
    kortix: Thousands on one config
    lean: kortix
  - dimension: Connectors
    them: 40+ apps, pre-indexed
    kortix: 3,000+ apps, MCP, OpenAPI, HTTP
    lean: kortix
  - dimension: Models
    them: Major providers, local or hosted
    kortix: Any provider, your keys
    lean: both
  - dimension: Where it runs
    them: Cloud, self-host, on-prem, air-gapped
    kortix: Cloud, VPC, or on-prem
    lean: them
```

## When to pick which

```verdict
themLabel: Onyx
them: you want an open-source, self-hostable search and answer layer over your company's apps, and finding the answer is the whole job.
kortix: you want agents that do the work search only surfaces, from one git repo you own, on any model, self-hosted or in the cloud.
```

For the closed, vendor-hosted version of this choice, [Kortix vs Glean](/blog/kortix-vs-glean) is the counterpart to this one. Two more open-source search-and-chat layers get the same treatment in [Kortix vs Open WebUI](/blog/kortix-vs-open-webui) and [Kortix vs LibreChat](/blog/kortix-vs-librechat).

Onyx is a strong open-source search layer, and if finding the answer is the job, it is a good one to keep. When the job is the work that follows the answer, run it on [Kortix](https://kortix.com): one git repo you own, an agent on every task, and a person on every merge. Free to start, free to self-host.
