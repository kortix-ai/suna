---
title: "The review gate is what separates open-source AI agent platforms"
description: "Five open-source AI agent platforms compared on who can stop an agent before production, and the settings that turn a review gate on."
date: "2026-09-16"
canonical: "https://kortix.com/blog/open-source-ai-agent-platform"
author: "team"
tags: ["Comparisons"]
updated: "2026-10-19"
slug: "/open-source-ai-agent-platform"
---
An open-source AI agent platform is a system for running AI agents on code you can read, fork and host yourself. The license answers what you may do with that code. It says nothing about whether an agent can send the invoice, merge a branch or change the CRM before a person has read the diff. That second question decides whether the platform belongs anywhere near production.

Five options are worth comparing in October 2026: Kortix, LangGraph, CrewAI, Dify and NocoBase. They sit at different layers of the stack, and the layer explains most of the difference in how each one handles review.

## What the five options are

Kortix is a company-wide system where agents, skills, memory and connectors live in one git repo the company owns. LangGraph and CrewAI are frameworks, libraries an engineering team imports into an application it is already building. Dify is a visual platform for LLM applications and retrieval pipelines. NocoBase is a no-code business system with AI employees inside it.

The layer decides who carries the review burden. A framework hands the runtime to engineering. An application platform keeps permissions inside the product it serves. A company-wide system has to answer a harder question: can an agent change how the company works without a person approving that change?

## The layer most platforms leave to you

A review gate is a checkpoint that holds an action until a person approves it. On an agent platform the gate needs two parts: a rule that stops a tool call, and a path for finished work to reach production only after review. Without both, permissions describe who may use the platform, not what an agent may do to the systems behind it.

The difference shows up at the moment of action. A role can say an agent may write to the CRM. It cannot say that this write, to this record, waits for the account owner. A per-tool rule can. A repository permission can let an agent push a branch, while a change request decides whether that branch reaches `main`. The five platforms differ on whether they ship both mechanisms or leave the pair to the application.

## Kortix: the review step is part of the platform

Kortix is the open-source AI Operating System: your agents, their skills, your company memory, and every connector in one git repo you own, with the agents working on real cloud computers. Work happens in a session, and session work reaches `main` through a change request. Merge is default-deny for agents. The change request carries the diff, the discussion and the decision, so a reviewer sees the exact configuration an agent changed before it becomes part of the company.

Approval gates cover the other direction, the tool calls an agent makes while it works. Approval gates you set. Off until you set them. That default matters because a new project looks governed when it is not: the starter manifest has no `policy:` block, and the manifest reference lists `policy.default_mode` with a default of `allow_all`. A connector call that matches no rule runs. A team that installs Kortix and stops there has a review path for files and no gate on what an agent does to Gmail or Stripe.

Run it on Kortix Cloud, in your VPC, or on your own on-prem network. Self-host is free. Free is $0 with 500 credits a month and 1 project; credits start at $50 a month, and members are free and share one credit pool ([Kortix pricing](https://kortix.com/pricing)).

Together, the change request and the gate cover the two ways an agent can change a company: the files in the repo and the systems outside it.

## What to switch on after install

A new project starts with a manifest from the starter at `packages/starter/templates/base/kortix.yaml` ([Kortix on GitHub](https://github.com/kortix-ai/suna)):

```yaml
kortix_version: 2
default_agent: kortix

agents:
  kortix:
    file: agents/kortix.md
    connectors: all
    secrets: all
    kortix_permissions: all
    skills: all
    workspace: { project_repository: true }
```

The block grants the default agent what it needs to work. It contains no `policy:` key, so nothing in the file holds a connector call. Add one:

```yaml
policy:
  default_mode: risk
policies:
  - match: gmail.send_email
    action: require_approval
```

`risk` lets a read run and sends a write or destructive call to approval. A rule can also carry `block` to stop a tool outright. Rules match a tool path, so a team writes one for each action that matters.

The manifest validator does not check `policy` or `policies`. A malformed rule is skipped when connectors sync, and the error appears in the connector settings rather than at merge time, so check the rules after the change lands ([manifest reference](https://kortix.com/docs/project/manifest)).

The change request path needs no switch. That is how session work lands by default, and the policy block is the part a team adds.

## LangGraph and CrewAI: the wiring is yours

LangGraph is a low-level orchestration framework for long-running, stateful agents ([LangGraph on GitHub](https://github.com/langchain-ai/langgraph)). Durable execution, memory and human-in-the-loop support are primitives: the graph pauses where you tell it to pause, and a person inspects or changes state at that point. Deployment and observability come from LangSmith, a separate product. That is a good trade for a team that wants the runtime inside its own code. The approval screen, the audit trail and the route to production are then application code, written and maintained by the same team.

CrewAI is an open-source Python framework for role-based agent teams, organized as Crews and event-driven Flows ([CrewAI on GitHub](https://github.com/crewAIInc/crewAI)). The framework is MIT licensed ([LICENSE](https://github.com/crewAIInc/crewAI/blob/main/LICENSE)). Managed deployment, observability and governance come from the commercial AMP Suite, which runs on-prem or in the cloud. Its hosted Basic plan is free with 50 workflow executions a month, and Enterprise is custom priced ([CrewAI pricing](https://crewai.com/pricing), checked October 2026). CrewAI suits a Python team that wants to compose agent teams and is willing to own or buy the control plane around them.

## Dify and NocoBase: review stays inside the app

Dify is an open-source LLM app development platform with a visual workflow canvas and a RAG pipeline ([Dify on GitHub](https://github.com/langgenius/dify)). The license is the Dify Open Source License, based on Apache 2.0 with additional conditions: a multi-tenant service needs commercial permission, and the console branding stays ([Dify license](https://github.com/langgenius/dify/blob/main/LICENSE)). The Community Edition self-hosts, while SSO and RBAC sit in Enterprise. Review in Dify happens at the application boundary, which is the correct boundary when the application is the deliverable.

NocoBase is an open-source AI and no-code platform for building business systems ([NocoBase on GitHub](https://github.com/nocobase/nocobase)). The NocoBase License Agreement incorporates Apache 2.0 with additional terms, and the free Community Edition sits beside Standard, Professional and Enterprise editions ([NocoBase license](https://github.com/nocobase/nocobase/blob/main/LICENSE.txt), [pricing](https://www.nocobase.com/en/commercial), checked October 2026). AI employees carry roles with field-level permissions, and audit logs record data changes. That is a working review layer, scoped to the business system rather than to a company's configuration files.

## Side by side

| Platform | License | Where it runs | What can stop an agent before production |
|---|---|---|---|
| Kortix | Open source | Kortix Cloud, VPC, on-prem, self-host | Change request; approval gates you set |
| LangGraph | MIT | Inside your app; LangSmith for deployment | Human-in-the-loop points you place |
| CrewAI | MIT | Your Python runtime; AMP Suite managed | Approval logic you code; AMP governance |
| Dify | Dify Open Source License | Cloud, VPC, Community self-host | App permissions; Enterprise RBAC |
| NocoBase | NocoBase License Agreement | Docker on your infrastructure | Roles, field permissions, audit logs |

The table shows the split. LangGraph and CrewAI give a team the pieces of a review step and leave the assembly to code. Dify and NocoBase give the app its own permissions, which is enough inside that app. Kortix treats the change request and the approval gate as platform features, and the thing under review is the company's own configuration.

## When to pick which

For a team that wants one system to run agents across the company, Kortix is the pick: the configuration sits in a repo the team owns, the review step is built in, and the same software runs in the cloud or on your own network. LangGraph fits when the runtime belongs inside your application and you want to place every interrupt yourself. CrewAI fits Python teams building role-based crews who will buy or build the control plane. Dify fits the team shipping a workflow or retrieval app, and NocoBase fits the team whose business system already exists and needs AI inside it. Those are different jobs from running a company on agents, and a framework or an app builder is the better tool for them.

If you are weighing a specific alternative, read [Kortix vs Claude Cowork](/blog/kortix-vs-claude-cowork) and [how to build reliable AI agent workflows](/blog/how-to-build-reliable-ai-agent-workflows).

Free to start, free to self-host. [Get started with Kortix](https://kortix.com).
