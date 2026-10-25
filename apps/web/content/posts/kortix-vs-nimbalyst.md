---
title: "Kortix vs Nimbalyst: a coding workspace, or the open-source AI Operating System"
description: "Nimbalyst is a visual coding workspace; Kortix is the open-source AI Operating System that keeps a company's agents and connector grants in one reviewed repo."
date: "2026-10-13"
canonical: "https://kortix.com/blog/kortix-vs-nimbalyst"
author: "team"
tags: ["Comparisons"]
updated: "2026-10-22"
slug: "/kortix-vs-nimbalyst"
---
Nimbalyst gives one developer a visual window for Claude Code and Codex sessions, and Kortix is the open-source AI Operating System: your agents, their skills, your company memory, and every connector in one git repo you own, with the agents working on real cloud computers. The difference shows when an agent's work stops being a patch and becomes a permission, a connector or a decision somebody else has to approve.

```logos
label: 'Compared here:'
items:
  - { name: Nimbalyst, domain: nimbalyst.com }
```

## What Nimbalyst does well

Nimbalyst is an MIT-licensed desktop app. It wraps the coding agents a team already pays for ([Nimbalyst on GitHub](https://github.com/nimbalyst/nimbalyst)). It runs on macOS, Windows and Linux, with an iOS companion, and it is free for individuals.

- **Several sessions at once.** Each agent gets its own git worktree, so sessions do not overwrite each other. A kanban board shows which one is waiting on you.
- **Review inside the document.** Agent edits appear as red and green diffs inside the rendered markdown, mockup or spreadsheet. You accept or reject each one before it is committed.
- **Editors for the work around code.** WYSIWYG markdown, Mermaid, Excalidraw, data models, CSV and Monaco share one window with the terminal and git.
- **Files stay plain.** Content and status are markdown on disk, so the repository works with or without the app.
- **A wiki the agents write.** The Nimbalyst Wiki is a plugin for Claude Code, Codex, Cowork, Cursor, VS Code or any MCP agent. It keeps decisions and open questions as markdown pages in the repo ([Nimbalyst pricing](https://nimbalyst.com/pricing)).

That is a good product for a developer running several agents on one repository, and the wiki is a real step toward shared context. It is also built around a person at a desk.

## Where the workspace model runs out

Nimbalyst organizes the session on a laptop. A company's agents need a different unit: the permission an agent holds, and the review that permission passes through.

- **Execution is local.** The agent runs against a worktree on the machine where the app is open. It uses that person's Claude or ChatGPT subscription, or an API key.
- **Review is per file, per person.** A red and green diff suits a patch one engineer is reading. It gives nobody a record of which agent gained a connector since last month.
- **Configuration sits beside the repo.** MCP servers, sign-ins and workspace settings are set up in the app. Git holds the documents and code the agents edit.
- **Team sharing is a wiki.** Wiki Teams puts one multiplayer wiki in front of a team. The grants behind the agents that write it stay outside the repository.

Those are the boundaries of the job Nimbalyst chose, and for a coding team they are sensible.

## The grant line a reviewer reads

Kortix treats the company as the repository. Agents, skills, memory, connector configuration and triggers are files in one git repo. A session is a branch of it. The starter agent file calls a session "an ephemeral branch of this repo" and says "only what you commit + push survives" ([agent file](https://github.com/kortix-ai/suna/blob/dev/packages/starter/templates/base/agents/kortix.md)).

A project's `kortix.yaml` carries the governance block for each agent:

```yaml
agents:
  kortix:
    file: agents/kortix.md
    connectors: all
    secrets: all
    kortix_permissions: all
    skills: all
```

Behavior lives in `agents/kortix.md`: the prompt, the model, the permission mode. The manifest decides what the agent may reach. It is deny-by-default, so an omitted connector, secret, permission or skill grant resolves to none. A scoped specialist starts locked down ([manifest reference](https://github.com/kortix-ai/suna/blob/dev/packages/starter/templates/base/kortix.yaml)). When an agent gains Stripe or a customer database, the change is one line in that block. It arrives on the default branch through a change request a person reads as a diff.

One isolated sandbox per session. Each session has its own isolated machine and branch. Session work reaches `main` through a change request. Merge is default-deny for agents, so an agent cannot land its own work unless an admin grants it the merge capability.

The stack sits where you want it. Run it on Kortix Cloud, in your VPC, or on your own on-prem network. Self-host is free. Any model provider with your own keys. Or the ChatGPT plan you already pay for.

## What each costs

Kortix prices in credits for the agent computer. Free is $0 with 500 credits a month and 1 project, on your own provider keys or a ChatGPT subscription. Paid plans start from $50 a month, at 1 credit = $0.01 and 11 credits = 1 hour of agent computer (checked October 2026). Members are unlimited on one shared credit pool, and unused credits roll over one month ([Kortix pricing](https://kortix.com/pricing)).

Nimbalyst is free for individuals: the app and the personal wiki. Sharing that wiki with a team is $200 per user a year, free while the beta lasts (checked October 2026, [Nimbalyst pricing](https://nimbalyst.com/pricing)).

## Where Nimbalyst wins

For work that stays inside one repository, Nimbalyst is the better tool. Diff review sits inside the document being edited. That beats a patch when the artifact is a mockup or a spreadsheet. Files stay on the machine, there is no cloud compute bill, and the MIT license lets a team read and change the app. The iOS companion keeps the session list in reach when you leave the desk.

Kortix asks a team to keep agents, grants and memory in a repository. That is more structure than a five-person engineering team needs.

## Side by side

| Dimension | Kortix | Nimbalyst |
| --- | --- | --- |
| Open source | Yes, self-host or managed cloud | App code MIT licensed |
| Agent support | The OpenCode harness, any model | Claude Code, Codex; OpenCode and Copilot in alpha (checked October 2026) |
| Where configuration lives | `kortix.yaml` and agent files in the project repo | App settings, with documents in git |
| Where agents run | Its own cloud computer per session | A worktree on the developer's machine |
| Who reviews the work | A person merges a change request | Each person approves diffs before commit |
| Price shape | Free tier, credits from $50 a month | Free for individuals, team wiki per user |

## Choosing between them

Choose Nimbalyst when the agents work on code and documents one team already holds, when the review you need is a patch, and when local files matter more than a shared machine. It is a well-built workspace for that job, and the wiki plugin is the simplest way to get agent-written decisions into a repository.

Choose Kortix when agents reach systems the whole company shares. Choose it when a connector grant has to pass a review, or when work has to start without somebody opening a laptop. The manifest turns access into a diff, and the change request turns the diff into a decision with a name on it.

A team can run both. Keep the coding loop in Nimbalyst, put the company's agents, connectors and memory in a Kortix project, and let the repository be where the two meet.

For the neighboring choice between a coding workspace and a company system, read the [Kortix vs OpenHands comparison](/blog/kortix-vs-openhands). If you are choosing a system rather than a workspace, see [how to pick an open-source AI agent platform](/blog/open-source-ai-agent-platform).

Kortix is free to start and free to self-host. Put one agent in a repo your team reviews, then add the connectors when the change is ready for a diff. [Get started with Kortix](https://kortix.com).
