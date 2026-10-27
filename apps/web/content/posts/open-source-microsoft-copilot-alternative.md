---
title: "The open-source Microsoft Copilot alternative depends on which Copilot you mean"
description: "Copilot is several products, so the open-source replacement is a search layer for answers and an agent system that lands work in a repo you own."
date: "2026-09-27"
canonical: "https://kortix.com/blog/open-source-microsoft-copilot-alternative"
author: "team"
tags: ["Comparisons"]
updated: "2026-10-22"
slug: "/open-source-microsoft-copilot-alternative"
coverLogos: [{"domain": "microsoft.com", "name": "Microsoft Copilot"}]
---
Ask for an open-source Microsoft Copilot alternative and the answer comes back as a list of search products: Onyx, Glean and similar products. That answer is half right. Copilot now leads with Home, Code and Autopilot, chat sits as one mode inside Home, and the weight has moved onto agents that finish work. The search products run agents of their own today, and where the finished work lands decides which of them you need. Kortix is the open-source system where it lands in a repository your company owns.

## What changed in September and October

Microsoft put chat, the Office apps and its agents into one Copilot app ([the September announcement](https://blogs.microsoft.com/blog/2026/09/25/introducing-the-new-copilot-with-home-code-and-autopilot)). Home is the starting point, where Chat and Cowork meet. Code builds an app or an automation from a description and runs it in a sandbox inside your tenant. Autopilot, previously Scout, is a cloud-hosted agent that keeps working without a prompt. Microsoft says you will soon state the outcome and Copilot will route the work to Chat, Cowork or Code.

Everyday chat stays on the per-user subscription. Cowork, Code, Autopilot and frontier models run on usage billing in Copilot Credits. The subscription is required before you can spend any ([pricing model](https://techcommunity.microsoft.com/blog/microsoft-copilot-blog/evolution-of-the-copilot-pricing-model/4559416)). A Cowork task is priced from model use, context retrieval, tool calls and runtime ([Cowork general availability](https://www.microsoft.com/en-us/copilot/blog/2026/06/16/copilot-cowork-is-now-generally-available/)). The seat no longer bounds the bill.

Two buying changes followed. From December 1, 2026, new Microsoft Copilot and Copilot Business offers can be bought without a qualifying Microsoft 365 base subscription, at the same prices. New Copilot Business licenses bought through the Cloud Solution Provider program arrive with usage billing on by default and a 4,000 credit per user monthly limit ([Partner Center, October 2026](https://learn.microsoft.com/en-us/partner-center/announcements/2026-october)).

## The three lanes inside the Copilot brand

**Coding assistant.** GitHub Copilot completes and edits code in your editor and terminal, sold per seat, and it is not available for GitHub Enterprise Server.

**Agent builder.** Copilot Studio is a closed Microsoft cloud service for designing and publishing agents.

**Company-wide agents.** Microsoft Copilot runs Cowork, Code and Autopilot, and Agent 365 governs the fleet. This is the lane where search products get recommended, and where the question of ownership gets decided.

## Lane 1: open-source coding assistants

GitHub Copilot's Free tier gives 2,000 completions a month and automatic model selection only. Pro is $10 a month, Pro+ $39, Max $100, Business $19 per granted seat, Enterprise $39, checked October 2026 ([plans](https://docs.github.com/en/copilot/get-started/plans)). None of it can be self-hosted or forked.

Two projects cover the work. [Cline](https://github.com/cline/cline) is Apache-2.0, runs in your IDE, terminal or desktop app, and calls its tools with human-in-the-loop approval. [Tabby](https://github.com/TabbyML/tabby) is a self-hosted completion server, Apache-2.0 outside its `ee/` directory, which carries a separate enterprise license ([Tabby license](https://raw.githubusercontent.com/TabbyML/tabby/main/LICENSE)). Both take the models you configure.

## Lane 2: open-source agent builders

Copilot Studio bills the tenant rather than the seat: 25,000 Copilot Credits in a pack at $200 a month, or a pay-as-you-go meter for what the agents spend, checked October 2026 ([pricing](https://www.microsoft.com/en-us/copilot/pricing/copilot-studio)). Internal agents come with a Copilot license. Publishing to websites, apps and social channels takes the standalone plan.

[LangGraph](https://github.com/langchain-ai/langgraph) is MIT and gives you durable execution, a human-in-the-loop interrupt and memory across sessions, as a library you assemble. [Botpress](https://github.com/botpress/botpress) is MIT in its current repo and suits a team that wants the studio ready-made; self-hosting means the older v12 server, licensed AGPLv3 ([Botpress v12](https://github.com/botpress/v12)).

## Lane 3: where the work lands

Microsoft's own layer here is closed and cloud-only. Cowork needs the subscription, bills each task in credits, ships off by default with spending limits an admin sets, and runs on Microsoft's cloud. Partner notes say Copilot is supported only on cloud-backed apps in Microsoft 365 suites, so there is no self-hosted version of this lane ([Partner Center](https://learn.microsoft.com/en-us/partner-center/announcements/2026-october)).

The products buyers are handed sit one step down from that. Onyx is an open-source search and context layer for a company's own tools. It syncs the permissions each source system enforces and applies them again each time someone asks, so an answer only cites documents the asker can already open. The index, the embeddings and the model traffic stay inside infrastructure your security team owns. Onyx deploys single-tenant, in a VPC, on-premises or fully air-gapped ([onyx.app](https://onyx.app), [deployment docs](https://docs.onyx.app/deployment/overview)). Its license splits: MIT outside the `ee/` directories, which carry the Onyx Enterprise License ([Onyx license](https://github.com/onyx-dot-app/onyx/blob/main/LICENSE)).

Onyx does the work as well now. Craft takes a goal from the prompt to a finished deliverable, planning the job, running code and creating files in a sandbox. Each session gets a separate workspace, and finished outputs are written to `outputs/` ([Craft](https://docs.onyx.app/overview/core_features/craft)). Custom agents combine instructions, knowledge and approved Actions that change a ticket, check a service or move a deal along ([agents](https://docs.onyx.app/overview/core_features/agents)). A team whose bottleneck is finding things and turning them into a document gets both jobs from one product.

Where it differs is where the result lives. Craft's work lands in a session workspace and in files you download or share through the running Onyx instance. The lane that matters is a repository the company owns, one branch per session. The change request it opens is default-deny for agents. When the work has to end up as a reviewed change to code, configuration or a skill, Onyx hands you a deliverable and stops there.

Glean is closed and sells search, an assistant and agents across 40+ models, with 275+ connections to work apps and data sources (checked October 2026) ([glean.com](https://www.glean.com)). A closed product cannot stand in for an open-source one, so it is the benchmark a search layer gets measured against rather than a candidate.

Kortix is our recommendation for the lane Copilot now occupies. It is the open-source AI Operating System: your agents, their skills, your company memory, and every connector in one git repo you own, with the agents working on real cloud computers. The starter project shows what a team actually holds. Its header reads this way today:

```yaml
# packages/starter/templates/base/kortix.yaml
# Kortix project manifest. Source of truth for project-wide config that
# lives in git alongside the code. `kortix_version` pins the schema so
# the platform can evolve safely. v2 manifests are YAML-only, with one
# `agents:` map per project — GOVERNANCE ONLY (connectors/secrets/
# kortix_permissions/skills/workspace/enabled), plus `file`, the path of the
# agent's `.md`. Agent BEHAVIOR (description, model, mode, temperature,
# permission, the prompt itself, …) lives entirely in that `.md`'s
# frontmatter + body — a stock OpenCode agent file works as-is.
kortix_version: 2

agents:
  kortix:
    file: agents/kortix.md
    connectors: all
```

The manifest names the file and grants the access. It never says what the agent is for, which model it runs or how it is prompted; that lives in `agents/kortix.md`, a stock OpenCode agent file a reviewer can read in a minute. A session runs on a branch of that repo, and the starter's front-door agent puts the stakes plainly: work that is never committed and pushed is work that does not survive. The thing a company audits is a file.

Kortix runs on Kortix Cloud, in your VPC or on-prem, and self-host is free. Any model provider with your own keys, or the ChatGPT plan you already pay for. Nothing merges itself: session work reaches `main` through a change request a person approves, unless an admin granted the `project.gitops.merge` capability ([Kortix docs](https://kortix.com/docs/git)).

OpenWork is the lighter option: a desktop app that runs an agent locally, MIT outside its `ee/` directory, which carries the OpenWork Enterprise Edition License ([OpenWork](https://github.com/different-ai/openwork)).

| Option | Open source | Where it runs | Where finished work lands |
|---|---|---|---|
| Kortix | Yes | Cloud, your VPC or on-prem | A branch, then a reviewed change request |
| Onyx | Yes, MIT outside `ee/` | Single tenant, VPC, on-prem, air-gapped | Session workspace and output files |
| OpenWork | Yes, MIT outside `ee/` | Your desktop | Your local machine |

## What the bills look like now

Microsoft's pages, checked October 2026: Copilot Business lists at $21 and sells at $18 per user per month paid yearly through December 31, 2026, or $25.20 monthly, and the enterprise add-on is $30 per user per month paid yearly ([business](https://www.microsoft.com/en-us/copilot/pricing/business), [enterprise](https://www.microsoft.com/en-us/copilot/pricing/enterprise)). Credits cost $0.01 under pay-as-you-go ([Cowork general availability](https://www.microsoft.com/en-us/copilot/blog/2026/06/16/copilot-cowork-is-now-generally-available/)). A new Copilot Business license through CSP carries a default 4,000 per user each month, which fully spent adds $40 a person to the seat ([Partner Center](https://learn.microsoft.com/en-us/partner-center/announcements/2026-october)). GitHub bills the same way, and charges $0.01 a credit past a seat's allowance ([plans](https://docs.github.com/en/copilot/get-started/plans)).

Kortix bills for the agent computer instead of the seat. Free is $0 with 500 credits per month, every feature and 1 project, on the user's own provider keys or ChatGPT subscription. Managed models are on the Credits plan only. The paid plan is credits: 100 credits per dollar, so 5,000 credits a month costs $50. Members are unlimited and free, and the account shares one credit pool ([Kortix pricing](https://kortix.com/pricing)).

## The map, and the lane you are in

| Copilot product | What it is | Open-source replacement | Why that one |
|---|---|---|---|
| Microsoft Copilot | Chat, Office, and the Cowork, Code and Autopilot agents | Kortix | Agents and memory as files in a repo you own |
| GitHub Copilot | Completion and a coding agent in the editor | Cline, plus Tabby for a self-hosted server | They run on your machine and take your models |
| Copilot Studio | A low-code studio for agents you publish | LangGraph, or Botpress for the studio | LangGraph is the orchestration, Botpress the studio |
| Agent 365 | The control plane that observes and governs agents | Kortix | Agent rules and the audit trail are files in the repository |

- **Faster code in your editor.** Cline or Tabby; both self-host.
- **Building and publishing agents.** LangGraph to own the orchestration, Botpress for a ready-made studio.
- **A governed workforce across company tools.** Kortix: agents and memory as files in a repo the team owns, where work lands through a change request a person merges unless an admin granted the agent `project.gitops.merge`.
- **Finding answers across the company.** Onyx, kept as the search layer, plus Kortix when the finding turns into a job someone has to do and a change someone has to approve.

If chat is all you need, Copilot Chat comes with eligible Microsoft 365 plans.

Two more reads: [Kortix vs Onyx](/blog/kortix-vs-onyx) and [Kortix vs Glean](/blog/kortix-vs-glean). [The open-source agent guide](/blog/open-source-ai-agent-platform) covers the field past Microsoft.

Pick the lane that matches your bottleneck, and [get started with Kortix](https://kortix.com) when the company's agent work should run on a repository you own. Free to start, free to self-host.
