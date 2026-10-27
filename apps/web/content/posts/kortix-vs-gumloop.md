---
title: "Kortix vs Gumloop: a read-only export or an open-source repo you can run"
description: "Gumloop offers a read-only export of an agent, while Kortix, the open-source AI Operating System, keeps that definition in a repo you can run."
date: "2026-10-05"
canonical: "https://kortix.com/blog/kortix-vs-gumloop"
author: "team"
tags: ["Comparisons"]
updated: "2026-10-22"
slug: "/kortix-vs-gumloop"
---
Gumloop is a strong no-code builder for a team that needs an agent this week, and Kortix is the open-source AI Operating System: your agents, their skills, your company memory, and every connector in one git repo you own, with the agents working on real cloud computers. The choice comes down to where the workflow definition lives, and whether you can run it somewhere the vendor does not control.

```logos
label: 'Compared here:'
items:
  - { name: Gumloop, domain: gumloop.com }
```

## What Gumloop gets right

- **A builder for the people doing the work.** Gumloop's own pitch is that understanding a task is the only prerequisite to automating it. A team can turn a process into an agent without writing code ([Gumloop](https://www.gumloop.com/)).
- **A company brain behind the agent.** Knowledge sources from Google Drive, Notion, Slack, GitHub and Confluence are indexed so an agent answers from company documents with citations ([Gumloop docs](https://docs.gumloop.com/core-concepts/agents)).
- **Triggers without a cron server.** Schedules and app events start an agent, and the API exposes the same triggers to your own systems ([trigger docs](https://docs.gumloop.com/core-concepts/agent_triggers)).
- **A broad model menu.** Gumloop's docs list Anthropic, OpenAI, Google, DeepSeek, Moonshot, MiniMax and Z.ai models, with a router that picks one per message and BYOK on Pro and above ([Gumloop models](https://docs.gumloop.com/core-concepts/ai_models)).
- **Oversight a security team will recognise.** Tool approvals pause an agent mid-task, and app rules block or log actions before they run. Enterprise adds audit logs, SAML SSO, SCIM and SOC 2 Type II ([Gumloop enterprise](https://www.gumloop.com/enterprise)).
- **A low entry price.** Pro starts at $37 a month and Enterprise is custom priced ([Gumloop pricing](https://www.gumloop.com/pricing)).

None of that is a knock on a hosted product. For plenty of teams it is exactly the right trade: someone else runs the service, and the workflow gets built.

## Where a hosted builder stops

The limits appear once agents stop being a side project and become infrastructure, and they start with the definition. An agent's connectors, triggers, access and settings are configured in the four tabs of Gumloop's builder. The docs describe the saved result as a version the API can read ([agent docs](https://docs.gumloop.com/core-concepts/agents)). Gumloop does let you pull that configuration; its own endpoint calls the operation an export and notes that it "cannot restore or deploy a version" ([version API](https://docs.gumloop.com/api-reference/agents/retrieve-agent-version)). You get a JSON snapshot of an agent, not software you can run.

Gumloop does not publish the product's source. Its public GitHub organization carries an editor plugin, an MCP fork and a Celery fork, not the builder or the runtime ([Gumloop on GitHub](https://github.com/gumloop)).

VPC deployment puts Gumloop's software inside your AWS, Azure or Google Cloud account, so data stays in your network ([enterprise](https://www.gumloop.com/enterprise)). Somebody still operates a vendor's product. You cannot read or change what runs.

Approvals are the other half. A tool call can pause for a person, which is the right guard for a send or a delete. It does not make the agent's definition reviewable as a diff before it changes.

## The manifest is the control plane

A Kortix project keeps the governance in a file. This is the starter's `kortix.yaml`:

```yaml
agents:
  kortix:
    file: agents/kortix.md
    connectors: all
    secrets: all
    kortix_permissions: all
```

That block is the whole grant. A reviewer reading a change request sees the file and the agent it points at. Every connector, secret and permission the agent may touch is in that block. The starter's own comment is explicit: v2 is deny-by-default, an omitted connectors/secrets/kortix_permissions/skills grant resolves to none, and "so a scoped specialist starts locked down" ([kortix.yaml](https://github.com/kortix-ai/suna/blob/dev/packages/starter/templates/base/kortix.yaml)).

The behaviour sits beside it in Markdown. The starter agent file describes its session as "an ephemeral branch of this repo, your own `/workspace`" where "Only what you commit + push survives" ([agents/kortix.md](https://github.com/kortix-ai/suna/blob/dev/packages/starter/templates/base/agents/kortix.md)).

Model choice is independent of the repo. Any model provider with your own keys. Or the ChatGPT plan you already pay for ([Kortix models](https://kortix.com/docs/project/models)).

Put those together and the review is ordinary code review. A new connector shows up as a line in a diff. A tightened permission shows up as a deletion. The config can be grepped, rolled back and cloned into another project, because it is text in git rather than rows in a vendor's database.

## What leaving costs

On Kortix the exit is a clone. The repo holds the agents, skills, memory and connector configuration. Run it on Kortix Cloud, in your VPC, or on your own on-prem network. Self-host is free ([Kortix docs](https://kortix.com/docs)). A managed cloud removes the ops work without changing where the config lives; self-hosting changes who runs it, not the file format.

On Gumloop the exit is a rebuild. You can export an agent's configuration as JSON, and on Pro or Enterprise you can keep organization skills in sync with a GitHub repository. The export is read-only by design, so it documents what an agent was rather than a package you can deploy. Neither gives you the builder or a runtime to point at the file, so the agents have to be reassembled somewhere else. That is a fair cost for a team that never intended to run infrastructure, and a real one for a team that did. The test is simple: try to rebuild one agent from what you can download. If that leaves you with a JSON file and a support ticket, the runtime stayed behind.

## Side by side

| | Kortix | Gumloop |
|---|---|---|
| Open source | Yes. Read it, fork it, audit it. | No; the product's source is not published |
| Hosted or self-hosted | Self-host, VPC, on-prem or Kortix Cloud | Their cloud, or Gumloop in your VPC |
| Where the definition lives | A git repo you own, as YAML and Markdown | Gumloop's builder, readable through its version API |
| Model choice | Any model provider with your own keys | 35+ models, with your own keys on Pro |
| Price shape | Free at $0; credits from $50 a month | Pro from $37 a month; Enterprise custom |

## How to choose

Pick Gumloop if the workflow is the asset and the runtime is not. A five-person operations team that wants a churn report every Monday, built by the person who owns renewals, gets there faster on a canvas than on a repo. The vendor runs the service, the model menu is wide, and the approval cards cover the risky steps.

Pick Kortix if the agents are becoming infrastructure. The definition has to be reviewable before it ships, and the same config has to run in a laptop sandbox and in your VPC. The company has to be able to leave with its agents intact. The price shape fits that reading too. The free plan costs $0 and includes 500 credits / month and 1 project. The Credits plan starts from $50 a month, and members share one pool ([Kortix pricing](https://kortix.com/pricing)).

Next reads: [Kortix vs Claude Cowork](/blog/kortix-vs-claude-cowork) and [what an open-source AI platform is](/blog/open-source-ai-agent-platform).

Start with [Kortix](https://kortix.com) and keep the agents, the grants and the memory in a repo your team owns.
