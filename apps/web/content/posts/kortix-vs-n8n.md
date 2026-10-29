---
title: "Kortix vs n8n: open source, and the unit of work you are paying for"
description: "n8n prices a run of a flow you can draw; open-source Kortix prices a session on its own machine, so the unit of work decides the bill."
date: "2026-10-08"
canonical: "https://kortix.com/blog/kortix-vs-n8n"
author: "team"
tags: ["Comparisons"]
updated: "2026-10-21"
slug: "/kortix-vs-n8n"
---
n8n is the canvas you reach for when the steps are already known, and Kortix is the open-source AI Operating System for the work that has no steps yet. Your agents, their skills, your company memory, and every connector live in one git repo you own, and each session runs on a cloud computer of its own. Either one can run on your own hardware, and n8n puts a person in the path with an approval step inside the flow. What separates them is the unit each one sells, a run of a drawn flow or a session you review, and that unit decides the bill long before the feature list does.

```logos
label: 'Compared here:'
items:
  - { name: n8n, domain: n8n.io }
```

## What n8n gets right

n8n is a fair-code workflow platform with a visual canvas, code nodes in JavaScript and Python, self-hosting or n8n Cloud, and models from OpenAI, Anthropic, Google or an open-source provider ([n8n on GitHub](https://github.com/n8n-io/n8n), checked October 2026).

- **The library is already built.** n8n's README claims 1,500+ integrations and 9,000+ workflow templates. Its integrations page listed 2,367 integrations in October 2026 ([n8n integrations](https://n8n.io/integrations/)).
- **The canvas is honest.** A flow of twelve steps looks like twelve steps. Anyone on the team can open it, find where a record is enriched, and change one node without reading code.
- **Approvals exist on every paid plan.** Human approval for tool calls is listed as included from the Starter plan up ([n8n pricing](https://n8n.io/pricing/)). That matters once an AI step sits in front of a production system.
- **Self-hosting is free of the quota.** The Community edition runs without a license key and you can stay on it indefinitely ([n8n docs](https://docs.n8n.io/hosting/community-edition-features/)). Execution limits belong to paid plans, cloud or self-hosted ([executions](https://docs.n8n.io/workflows/executions/)).
- **Its license is narrow on purpose.** The Sustainable Use License limits use to "your own internal business purposes". An agency that wants to host n8n for its clients needs an n8n license ([LICENSE.md](https://github.com/n8n-io/n8n/blob/master/LICENSE.md)).

## An execution is a run of a path you already drew

n8n's definition is exact: "An execution is a single run of a workflow" ([n8n docs](https://docs.n8n.io/workflows/executions/)). A schedule trigger counts one execution every time it fires, regardless of outcome. A webhook counts one for every inbound request that activates the trigger, including a request with an empty body. Manual test runs never count.

The pricing page says you pay only when a workflow runs from start to finish ([n8n pricing](https://n8n.io/pricing/)). The meter counts attempts. A run that fires at three in the morning and dies on a branch nobody anticipated is billed, and so is the retry once the branch is built. A workflow meter is cheapest when the drawing is already right. When it is not, the price is per guess.

n8n's agent nodes close part of that gap. An AI Agent node chooses its own tool calls inside one execution, so a loop of ten decisions still costs a single run. The frame around the loop stays fixed: the trigger that fires it, the tools it may call, the branch after its answer, the error path. A person draws all four before the job arrives.

The Starter tier costs €20 a month billed annually for 2,500 executions ([n8n pricing](https://n8n.io/pricing/), checked October 2026). That is a low number for a flow that finishes. It stops being a number you can plan against once a decision you have not seen sets the count of runs.

## The grant file n8n has nowhere to put

Every Kortix project is a git repository, and the part that governs an agent is a short block of YAML inside it. These lines come from the starter manifest that ships with a new project: the file is `packages/starter/templates/base/kortix.yaml` in [Kortix on GitHub](https://github.com/kortix-ai/suna) (read October 2026). The header of that file labels the `agents:` map GOVERNANCE ONLY, and it sets the default that matters:

```yaml
# v2 is deny-by-default: an omitted connectors/secrets/kortix_permissions/
# skills grant resolves to "none", so a scoped specialist starts locked down.
agents:
  harness-reflector:
    file: agents/harness-reflector.md
    kortix_permissions: all
    skills: all
```

That agent has no `connectors` or `secrets` line, so under v2 it has neither. The agent in the block is a file, and its behaviour is text you can read. Its reach is a list of grants. An omitted one resolves to `none`, so a specialist stays narrow unless someone widens it. Because the block lives in the project's repository, a new grant can arrive as a diff in a change request, next to the prompt change that needed it.

n8n has access control as well: instance roles, project roles, and credentials grouped into projects ([n8n RBAC](https://docs.n8n.io/administer/manage-users-and-access/set-permissions-and-roles-rbac)). It also lists Git version control for workflows on its Business tier ([n8n pricing](https://n8n.io/pricing/), checked October 2026). What it versions is the flow itself, the nodes and their settings. What the assistant may reach stays a credential and a project role in the running instance, set in the app and stored in its database. A reviewer can see who may edit a workflow. No screen shows a file where the agent's reach is written down beside the job it does.

## What a Kortix session costs

Kortix sells the other unit. Each session gets its own isolated machine and branch, so a session that guesses wrong spends minutes on a computer you can watch, stop, and pay for by the second.

The price is published in credits. Free is $0 with 500 credits a month, every feature and 1 project, on your own provider keys or ChatGPT subscription. Paid plans start at $50 a month, and every tier buys credits at 1 credit = $0.01: the $200 tier carries 20,000 credits a month, about 1,830 agent-computer hours. Members are unlimited and free on one shared pool ([Kortix pricing](https://kortix.com/pricing), checked October 2026).

Credits buy machine time. The pricing page states the rate plainly: 11 credits is an hour of agent computer, billed per second, and a stopped machine costs nothing. A job that needs four attempts costs four attempts' worth of minutes, and you can cap the clock. Attempts are the number nobody can forecast. Minutes are the number you can.

Run it on Kortix Cloud, in your VPC, or on your own on-prem network, and self-hosting is free. Session work reaches `main` through a change request. Merge is default-deny for agents. A grant edited in the repo is reviewed in that change request; a dashboard config edit commits straight to the default branch.

## Where n8n is the better pick

If the job is a flow you can draw, n8n is cheaper and simpler than anything we would ask you to run. The Community edition carries no execution quota, so on a self-hosted install the per-run price never enters the decision at all. A nightly reconciliation between two systems, a webhook that enriches a lead and posts it to Slack, an export at the same minute every day: build those in n8n and leave them there. We would not move a working flow off n8n to prove a point about units.

## What each meter actually counts

| Dimension | Kortix | n8n |
|---|---|---|
| Open source | Yes, self-host or managed cloud | Source visible under the Sustainable Use License |
| Unit of work | An agent session on its own machine | An execution of a flow you drew |
| Hosting | Kortix Cloud, your VPC, on-prem; self-host free | Self-hosted Community edition, or n8n Cloud |
| Model choice | Any model, your own keys | OpenAI, Anthropic, Google or open-source models |
| Review gate | Session work lands as a change request a person approves | Approval steps inside the flow |
| Price shape | Credits for machine time, billed by the second | Per execution on paid plans |

## Which unit your job needs

Write the job down as a list of steps you could hand a new colleague. If you can finish the list, and it will still be right next quarter, the unit is a flow. n8n is the cheaper tool for it, and a canvas is the clearest way to keep a clocked job running.

If the list contains a line that reads "work out why" or "decide whether", the unit is a session. A test that fails intermittently. A report assembled from four systems. A competitor's pricing page rebuilt from a PDF. None of those arrive with a step count. Kortix is the recommendation for that second kind of job. It keeps the agents, the grants, and the memory in one repo. Each session bills by the second on a machine of its own, and a person reads the change request before the work reaches `main`. A team that ends up with both gives n8n the jobs that fire on a schedule and brings the ones that arrive without steps here.

Related reading: [Kortix vs Activepieces](/blog/kortix-vs-activepieces), [Kortix vs Zapier](/blog/kortix-vs-zapier) and [how to build reliable AI agent workflows](/blog/how-to-build-reliable-ai-agent-workflows).

Kortix is free to start and free to self-host. [Get started with Kortix](https://kortix.com) and hand it the job whose steps you cannot list yet.
