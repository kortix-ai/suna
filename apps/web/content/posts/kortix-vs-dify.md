---
title: "Dify draws one app on a canvas. Open-source Kortix keeps the agents in a repo your team reviews"
description: "Open-source Kortix runs a company's agents, memory and connector rules as files in a repo it owns; Dify builds LLM apps on a canvas."
date: "2026-10-13"
canonical: "https://kortix.com/blog/kortix-vs-dify"
author: "team"
tags: ["Comparisons"]
updated: "2026-10-22"
slug: "/kortix-vs-dify"
---
Dify is one of the strongest open-source ways to build an LLM application, and Kortix, the open-source AI Operating System, keeps a company's agents, memory and connector rules in a repo a team reviews. Both tools self-host, and both take your model keys. What separates them is the unit of work: an application you compose and ship, or a workforce a company runs and governs.

```logos
label: 'Compared here:'
items:
  - { name: Kortix, domain: kortix.com }
  - { name: Dify, domain: dify.ai }
```

## What Dify gives you

Dify is a platform for LLM app development, and it is organised around one artefact: the application. You wire the pieces on a visual canvas, a model node here, a retrieval step there, a tool call, an output. Text extraction covers PDFs, slides and the other common formats, so document question answering works without a second stack beside it. The model layer covers hundreds of proprietary and open-source LLMs from dozens of inference providers ([Dify on GitHub](https://github.com/langgenius/dify), core feature 2). Publish, and the same flow becomes a web app or an API.

The rest of the product sits around that canvas: an agent sandbox where commands run and files get handled, a Marketplace of tools and app templates, a prompt IDE, and tracing through Opik, Langfuse or Arize Phoenix ([Dify on GitHub](https://github.com/langgenius/dify)).

## Where the canvas is the right tool

For a team whose deliverable is one AI feature, Dify's choices line up with the work.

- **You can see the whole path.** Input, retrieval, model, output, drawn as nodes, so a reviewer follows the flow without reading code ([Dify on GitHub](https://github.com/langgenius/dify)).
- **Retrieval ships with it.** Ingestion, indexing and search arrive together, which is most of a document assistant before anyone writes a line.
- **The output is a product.** A web app or an API, ready for customers, rather than a repo for engineers to run.
- **Standing it up is short.** A free Community Edition self-hosts with Docker Compose, and SSO and RBAC sit one tier up in Dify Enterprise ([Dify on GitHub](https://github.com/langgenius/dify)).

A team shipping one customer-facing AI feature gets all four on the first afternoon.

## The limits a company meets

A company runs more than one application. At that point a few properties of a canvas start to matter.

- **Configuration lives in Dify's workspace.** Applications, knowledge bases and model settings sit in its workspace database and are edited through its UI. Chatflow and Workflow apps keep a version history, and each app exports as a YAML DSL file ([Dify version control](https://docs.dify.ai/en/cloud/use-dify/build/version-control), [app management](https://docs.dify.ai/en/cloud/use-dify/workspace/app-management)). A prompt review therefore happens in Dify's interface or on an exported file. What Dify does not do is run a session's work as a branch plus a change request.
- **The app is the boundary.** Each application runs the nodes you drew and keeps its own conversation memory, and no review path connects one application to the next. Knowledge bases are the exception, since you can create several and reuse them across apps ([Dify knowledge docs](https://docs.dify.ai/en/cloud/use-dify/knowledge/readme)).
- **The licence adds conditions.** Dify ships under the Dify Open Source License, a modified Apache 2.0: no multi-tenant service without written permission, and the console logo and copyright stay in place ([Dify LICENSE](https://github.com/langgenius/dify/blob/main/LICENSE)).
- **Governance is a paid tier.** SSO and fine-grained roles are Enterprise features, so the free Community Edition leaves part of the control plane commercial ([Dify on GitHub](https://github.com/langgenius/dify)).

An app builder is not asked to solve any of that. A company with twenty applications is.

## The repository is the system

Kortix puts the system where a company already keeps its code. Agents sit in `agents/` as Markdown files. Beside them, `kortix.yaml` names the image a session starts from, the connectors it may reach and the triggers that start one, along with secret names and grants; no secret value is ever written into the repo ([Kortix docs](https://kortix.com/docs)).

That arrangement lets a company be read the way code is read. Everything that configures an agent, and every change it proposes, is a file you can grep and diff: grep every agent that touches a connector, diff a prompt change, revert a bad instruction with the same command you would use on any other file. Members, roles and routing stay live project state.

Triggers show the difference best, because a session can start with nobody opening anything. Here is one trigger block from a project's `kortix.yaml`:

```yaml
triggers:
  - slug: daily-triage
    type: cron
    cron: "0 0 9 * * 1-5"
    timezone: Europe/Berlin
    prompt: Triage yesterday's tickets and open a change request with the digest.
```

The expression takes six fields, seconds first, so this one fires each weekday morning. A trigger that names no agent runs under `default_agent`.

Every session opens on a machine of its own, on a branch cut from the repo, so thousands run at once without touching each other's files. Model traffic goes to a provider you hold a key with, or through the ChatGPT plan the company already pays for. Connector credentials are brokered server-side and never enter the machine.

## A person reads the diff

An agent's work is governed through Git: it reaches the default branch as a change request a person reviews, and an agent cannot merge its own work unless an admin grants that capability, so a colleague sees the change before it lands ([Kortix on GitHub](https://github.com/kortix-ai/suna)).

Connector calls are governed one action at a time. Each carries a rule that says run, ask first or block, and a rule can reach the individual arguments of a call. Anything set to ask holds the agent's turn until somebody approves. Permissions work the same way, granted per resource to people and to agents, with roles, groups and a record of every action ([Kortix docs](https://kortix.com/docs)).

The two outputs differ in kind. Dify produces an application you publish. Kortix produces a change a colleague can read, discuss and revert like any other commit.

## Where Dify is the faster build

For one well-scoped feature, Dify wins on time. Its Community Edition is a single Docker Compose stack, its canvas needs no repo, and retrieval works on day one ([Dify docs](https://docs.dify.ai/en/self-host/deploy/quick-start/docker-compose)). Kortix asks for a repo, a review habit and a sandbox provider, which is overhead an app builder does not need. When the deliverable is one application, take Dify and start today.

## Side by side

```compare
them: Dify
rows:
  - dimension: Open source
    them: "Yes, Apache 2.0 with added conditions"
    kortix: "Yes"
    lean: both
  - dimension: How you build it
    them: "Drag nodes on a visual canvas"
    kortix: "Edit files in a git repo you own"
    lean: them
  - dimension: Unit of work
    them: "An app or workflow you compose"
    kortix: "A session on its own cloud computer"
    lean: both
  - dimension: Where configuration lives
    them: "The Dify workspace database"
    kortix: "Files in the repo"
    lean: kortix
  - dimension: How work lands
    them: "Published as a web app or API"
    kortix: "A change request a person reviews"
    lean: kortix
  - dimension: Document retrieval
    them: "Built-in pipeline for PDFs and slides"
    kortix: "Company memory as files"
    lean: them
  - dimension: Models
    them: "Hundreds of models, dozens of providers"
    kortix: "Any model, your keys"
    lean: both
  - dimension: Self-hosting
    them: "Community Edition on Docker Compose"
    kortix: "Cloud, VPC, or on-prem"
    lean: both
  - dimension: Pricing
    them: "Free Sandbox; Professional per workspace"
    kortix: "Free; credits from $50 a month"
    lean: both
```

## When to pick which

```verdict
themLabel: Dify
them: You want to compose LLM applications and retrieval pipelines on a canvas, publish them as web apps or APIs, and ship a customer-facing feature without running a repo.
kortix: You want a governed system where agents, memory and connector rules are code in a repo you own, each session runs on its own computer, and every change lands through a review.
```

Kortix bills in credits. Free is $0 with 500 credits per month, every feature and 1 project, on your own provider keys or a ChatGPT subscription. The paid plan runs from $50 a month at 100 credits per dollar, and self-host is free ([Kortix pricing](https://kortix.com/pricing)). Dify Cloud starts on a free Sandbox plan and moves to a paid Professional plan per workspace, with Enterprise priced per deal ([Dify pricing](https://dify.ai/pricing)).

Next reads: [the best self-hosted AI workspace](/blog/best-self-hosted-ai-workspace), [Kortix vs n8n](/blog/kortix-vs-n8n), and [how to choose an open-source AI agent platform](/blog/open-source-ai-agent-platform).

Give one team one job and let it land as a change you read first. [Start with Kortix](https://kortix.com), on our cloud or on your own.
