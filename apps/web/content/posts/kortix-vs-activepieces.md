---
title: "Kortix vs Activepieces: open source for the work a flow cannot hold"
description: "Activepieces runs the flows you draw. Kortix is open source and built for the work a fixed flow cannot capture."
date: "2026-10-15"
canonical: "https://kortix.com/blog/kortix-vs-activepieces"
author: "team"
tags: ["Comparisons"]
updated: "2026-10-22"
slug: "/kortix-vs-activepieces"
---
Activepieces is a strong open-source flow builder; Kortix is the open-source AI Operating System for jobs whose shape changes while you are doing them. The work a flow builder handles well is work you can already describe. Both self-host. Both give you a way to hold a step for a person. So the choice turns on one question: where do the exceptions live once the job stops matching the diagram?

```logos
label: 'Compared here:'
items:
  - { name: Activepieces, domain: activepieces.com }
```

## What Activepieces gets right

Activepieces is an open-source automation platform that calls itself "an open source replacement for Zapier" ([Activepieces on GitHub](https://github.com/activepieces/activepieces)). A flow is a trigger plus a row of steps. It runs the same way every time it fires.

- **The connector library is already built.** 280+ pieces ship as TypeScript packages on npm, and each one doubles as an MCP server an LLM can call ([Activepieces on GitHub](https://github.com/activepieces/activepieces), checked October 2026). The repository says 60% come from the community.
- **The open core is really open.** The community edition is MIT. The enterprise features sit under a commercial license beside it ([Activepieces on GitHub](https://github.com/activepieces/activepieces)).
- **The price is flat.** Free is $0 with 1,000 credits a month, unlimited flows and up to 5 people. Plus is $20 flat a month for 10,000 credits, then $0.007 per credit. Team is $200 flat for 50,000 credits and 25 people with SSO ([Activepieces pricing](https://www.activepieces.com/pricing), checked October 2026).
- **A person can stop a flow mid-run.** Delay and approval are pieces in the same library, so a hold is a node in the diagram.
- **Embedding is a product.** If you want a builder inside your own app under your own brand, Activepieces sells that from $36k a year ([Activepieces pricing](https://www.activepieces.com/pricing), checked October 2026).

For a job that ends, those are the right properties: a visible path and a connector you did not have to write.

## The exception pile

Here is one job a team actually has. A competitor reprices its Plus plan, and five pages on your site still quote the old number. In a flow builder the work looks like four nodes: watch the page, fetch it, compare the number, update the page.

Then the job arrives, and the nodes multiply. The pricing page renders in the browser, so the fetch grows a headless browser step. One article quotes the annual figure, so a branch reads the billing period. Legal decides the comparison table should stop quoting competitor prices, so another branch edits the table out. Three months later the vendor renames the tier. The selector that reads the price returns nothing. The person who added the branch has moved teams.

Each change was reasonable on the day it was made. Stacked together they are the exception pile: a node for every case, a version for every fix. The diff history records what changed, never why. Activepieces keeps that pile tidy, since flows are fully versioned and the builder shows every branch ([Activepieces on GitHub](https://github.com/activepieces/activepieces)). What the diagram cannot show is why branch seven exists. That reason lived in one person's head.

An open-ended job pushed into a flow because a flow was already there surfaces months later as branches nobody can explain.

## The same job as a session

A Kortix session starts from the sentence instead of the diagram. You hand an agent the job in plain words: a competitor moved its Plus tier, find every page we publish that quotes its price, correct them, and open a change request. The session plans its own steps. It greps the project repo, opens the pricing page in a browser, judges which pages are stale, edits them, runs the build, and opens the change request.

Each session has its own isolated machine and branch. That is what makes the planning safe to run. Two jobs cannot collide in one working tree, and the branch carries the session id. Session work reaches `main` through a change request, and merge is default-deny for agents unless their `kortix_permissions` grant includes `project.gitops.merge`. With that grant left out, the diff waits for a person. When the vendor renames a tier next quarter, the exception is a decision inside that morning's plan. Nobody has to remember a node.

## The grant is a line in the repo

What makes that review real is that the configuration is a file. A project is a git repository with `kortix.yaml` at the root. Agents, skills, memory, triggers and connectors are files inside it ([Kortix docs](https://kortix.com/docs)). A v2 project starts with this block, as the [manifest reference](https://kortix.com/docs/project/manifest) publishes it:

```yaml
kortix_version: 2
default_agent: kortix
agents:
  kortix:
    file: agents/kortix.md
    kortix_permissions: all
```

That last line decides how much review the job gets. `all` includes `project.gitops.merge`, so the starter agent can merge its own change request. Give it a list without that permission and a person merges every change the agent opens. The rule sits one grep away from the prompt it governs. A change to it made on a session branch arrives as a diff a teammate reads.

Kortix bills machine time in credits. Free is $0 with 500 credits per month and 1 project, on your own provider keys or a ChatGPT subscription; managed models are on the Credits plan only. Paid starts at $50 a month. Every tier buys credits at 1 credit = $0.01, and the $200 tier carries 20,000 credits, about 1,830 agent-computer hours. Members are unlimited and free, and the account shares one credit pool ([Kortix pricing](https://kortix.com/pricing), checked October 2026). A running machine bills by the second. A stopped one costs nothing. A job that needs four attempts pays for four attempts, and you can watch each one.

## Where Activepieces is the cheaper answer

If the job is a sequence you can write down, and it will still be right next quarter, put it in Activepieces and leave it there. A nightly export, an invoice that lands in a spreadsheet, a form that opens a ticket: the flow is short and the piece exists. The free tier may cover the whole thing. Self-hosting costs nothing extra and is available on every plan, the free one included ([Activepieces pricing](https://www.activepieces.com/pricing), checked October 2026).

The bill is easier to defend too. A flat $20 a month is one line in a budget. Credits for machine time are harder to forecast for a job that thinks for twenty minutes. Activepieces now ships agents and chat in the same workspace, and its pricing counts an agentic action at 1 credit ([Activepieces pricing](https://www.activepieces.com/pricing), checked October 2026). Those agents work inside the same instance and the same versioned builder, which suits a job whose boundaries you can state.

Teams that run both kinds of work should keep the flow builder for the clockwork. Moving a working flow off a tool that runs it correctly would cost a rebuild and buy nothing.

## Side by side

```compare
them: Activepieces
rows:
  - dimension: Open source
    them: Community edition under the MIT license
    kortix: Yes, self-host or managed cloud
    lean: both
  - dimension: Unit of work
    them: A flow of steps you draw
    kortix: A session that plans its own steps
  - dimension: Adding an exception
    them: A new branch, then a new version
    kortix: A decision inside the next session
  - dimension: Where the configuration lives
    them: Flows in the Activepieces instance
    kortix: Files in a git repo you own
  - dimension: Model choice
    them: Your own AI keys on paid plans
    kortix: Any model, your own keys
  - dimension: Deployment
    them: Cloud or on-prem on every plan
    kortix: Kortix Cloud, your VPC, on-prem
    lean: both
  - dimension: Pricing model
    them: Flat plans metered in credits
    kortix: Credits for machine time, one shared pool
  - dimension: Review gate
    them: Delay or approval steps inside a flow
    kortix: Work lands as a change request; a merge needs a grant or a person
```

## Which job goes where

```verdict
themLabel: Activepieces
them: You want a flow builder you can draw, self-host, and embed in your own product, for a sequence that does not change shape.
kortix: You want agents that take a job you can describe but not draw, on machines of their own, with the grants and memory in a repo you own.
```

Ask what the job does the next time it surprises you. In Activepieces, someone opens the builder, adds a branch, and ships a new version. In Kortix, the next session meets the exception in its plan, and the diff it opens waits for review unless the agent holds the merge grant. A sequence that fires on a clock belongs in the flow builder. A job whose exceptions outnumber its steps belongs here. [Try Kortix](https://kortix.com) with the job whose next step you cannot predict.

Related reading: [Kortix vs n8n](/blog/kortix-vs-n8n) and [Kortix vs Zapier](/blog/kortix-vs-zapier).

```cta
title: Bring the job that will not sit still.
body: Free to start, free to self-host.
```
