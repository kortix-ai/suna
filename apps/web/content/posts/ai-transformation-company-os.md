---
title: Consultancies need one repo for their clients’ agents
description: Why consultancies need one git repo for their clients’ agents, memory, connectors, policy, and auditable work.
date: '2026-06-29'
author: team
tags:
  - Enterprise
  - AI Transformation
  - Company OS
cover: /banner.png
canonical: https://kortix.com/blog/ai-transformation-company-os
readingTime: 6
lead: AI transformation is past the demo phase. The hard part now is not proving that an agent can draft a report, inspect a spreadsheet, or update a CRM record. The hard part is giving every client, department, and delivery team a **repeatable operating layer** where agents, context, connectors, policy, and review live together. That is what a company OS is for.
---

Kortix is the open-source **AI Management System**: a workforce of agents does real work, and everything that defines the system is files in one git repo you own. For consultancies, that matters because the deliverable is no longer a single chatbot. The deliverable is a governed project the client can keep running after the pilot. If you want the full product spine first, read [Introducing Kortix](/blog/introducing-kortix).

The market is already pointing this way. [Accenture AI Refinery](https://www.accenture.com/us-en/services/ai-data/ai-refinery) frames enterprise AI around agents, knowledge, models, and governance. [Deloitte](https://www.deloitte.com/in/en/services/consulting/services/engineering-ai-data/agentic-ai.html) describes multiagent systems that understand requests, plan workflows, coordinate role-specific agents, collaborate with humans, and validate outputs. The missing question is where all of that lives so it can be owned, reviewed, repeated, and ported into the tools people already use.

## The pilot is not the product

Most AI-transformation work starts with a useful prototype: a support agent, a sales-research assistant, a finance close helper, a legal intake workflow, a marketing campaign planner. The prototype proves demand. Then the real work starts.

- **Who owns the instructions?** If the prompt lives in one vendor dashboard, the client cannot audit or improve it like normal operational IP.
- **Where does the context accumulate?** If every tool stores a different slice of memory, the organization never gets one shared brain.
- **How are tools governed?** Reading a CRM, sending an email, querying Stripe, and posting in Slack should not have the same permission profile.
- **How does the work become official?** A finished deliverable needs review, history, rollback, and a clear path into the client’s source of truth.
- **How do you repeat it for the next department?** The second workspace should be a fork, not a rebuild.

A proof of concept can avoid those questions. A production AI-transformation program cannot. The operating layer becomes the product because it decides whether the client gets a one-off demo or a system that keeps improving.

## One client, one repo

In Kortix, a project is a repo. That repo contains the company’s agents, skills, memory, triggers, connector policy, sandbox definition, and operating instructions. One `kortix.yaml` defines how the workspace runs. Every session happens on an isolated branch. Every persistent change comes back through a change request.

```
acme-ai-workspace/
├─ kortix.yaml              # project, sandboxes, triggers, connectors, policy
├─ agents/                  # role-specific agents: finance, support, sales, legal
├─ skills/                  # repeatable client playbooks and workflows
├─ memory/                  # durable company context and decisions
├─ harnesses/opencode/
│  └─ commands/             # approved operating motions
├─ artifacts/               # reports, briefs, packets, launch plans
└─ docs/                    # source-of-truth operating docs
```

That sounds technical because it is. It is also the reason the workspace can be handed to a client without trapping them in your service team forever. Files can be inspected. Diffs can be reviewed. A successful sales-ops workspace can be forked into a recruiting workspace. A regulated client can run the same pattern in their own VPC or on-prem environment. The [docs](/docs) walk through the project, session, and change request model in detail.

## The workspace needs five layers

If you are leading AI transformation for a client, a serious agent workspace needs more than a chat UI. It needs at least five layers working together:

- **Context.** The policies, playbooks, decisions, customer notes, docs, and memory the agents need to act like part of the company.
- **Agents and skills.** Named roles and reusable workflows, not one giant prompt that tries to do everything.
- **Connectors.** Access to the real systems of work — Slack, Gmail, HubSpot, Stripe, Linear, Notion, warehouses, internal APIs — brokered through scoped credentials instead of pasted keys.
- **Policy.** Tool-level allow, ask, and block rules so a workspace can automate research freely and still pause before it sends, pays, deletes, or posts.
- **Review.** A change request path for durable work: what changed, who requested it, what the agent touched, and what a human approved.

> The unit of delivery is not “an agent.” The unit of delivery is a governed workspace where many agents can do real work safely.

## Governance belongs in the runtime

Enterprise buyers do not just ask whether the model is good. They ask where secrets live, how access is scoped, what gets logged, how approvals work, how quickly a bad change can be reverted, and whether the system can run under their infrastructure constraints.

Kortix was built around those constraints. Sessions run in disposable Linux sandboxes on their own branches. Connectors are brokered server-side through one scoped token. Secrets are encrypted and injected at runtime, not shown to the model. Work reaches `main` only through reviewed change requests. The same workspace can be used from the web, Slack, Teams, CLI, API, and MCP surfaces instead of forcing every employee into a new destination app.

That is the difference between “we connected an LLM to your tools” and “we gave your organization a controlled workforce.” The first is exciting in a workshop. The second survives procurement, security review, and the third month of production use.

## Why consultancies feel this first

Consultancies and systems connectors are where the repeatability pressure shows up fastest. They do not need one beautiful demo. They need a way to deploy the same architecture across many clients, many departments, and many compliance profiles without rebuilding the plumbing every time.

- **For the AI-transformation partner:** one horizontal platform can become the delivery substrate for many vertical offerings.
- **For the client CTO:** the workspace is Git-backed, self-hostable, and inspectable instead of a vendor-owned service wrapper.
- **For the delivery team:** each department gets its own agents, memory, connectors, and policies without losing the shared pattern.
- **For the end user:** the agent shows up where they already work — Slack, Teams, web, CLI, API — instead of asking the 99% of employees to adopt another AI portal.

This is also where open matters. A consultancy cannot credibly tell a bank, manufacturer, or healthcare company that their future operating layer is a closed prompt stack nobody can inspect. The closer agents get to real work, the more the client needs to own the substrate. That is why Kortix is open, self-hostable, and built for enterprise deployment from the start.

## What to build first

The best first workspace is narrow enough to ship and important enough to prove the operating model. Pick one workflow where the client already has documents, tools, approvals, and recurring pain. Then encode it as files.

- **Sales renewal workspace:** read CRM context, summarize account risk, draft renewal plans, open human-reviewed follow-ups.
- **Support triage workspace:** monitor tickets, classify urgency, draft replies from docs, escalate edge cases with evidence.
- **Finance close workspace:** pull reconciliations, produce variance notes, flag missing evidence, create the close packet for review.
- **Recruiting workspace:** source candidates, enrich profiles, draft Marko-style outreach, log every touch, never send without approval.
- **Engineering review workspace:** review PRs, run checks, verify previews, and return concrete blockers instead of vague comments.

Those are not abstract use cases for us. Kortix runs internal sweeps for production errors, PR review, docs maintenance, weekly briefs, outbound research, and this SEO/blog loop from the same project-native model: agents with skills, memory, tools, triggers, and a reviewed path for durable changes.

## A quick test for your stack

Before you choose an AI-transformation platform, ask five questions:

- Can the client clone or export the actual operating layer — agents, skills, memory, policy, and triggers — as files?
- Can two hundred agents run in parallel without sharing one fragile machine or one user’s desktop state?
- Can tool access be scoped per person, group, agent, and action?
- Can a security reviewer see what happened after the fact: prompts, tool calls, commits, approvals, and diffs?
- Can the same workspace move from cloud to VPC to on-prem without changing the basic model?

If the answer is no, you may still have a good agent demo. You do not yet have a company OS.

```cta
title: Build the client workspace as files, then run it with agents.
body: Start with one department, connect the tools it already uses, and turn the workflow into a git-backed project the client can own.
```
