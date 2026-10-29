---
title: "Introducing Kortix, the open source operating system for AI agents"
description: "Kortix is open source: a workforce of AI agents that do real work across your tools, defined as files in a git repo."
date: "2026-06-06"
canonical: "https://kortix.com/blog/introducing-kortix"
author: "marko"
tags: ["Product", "Vision"]
updated: "2026-10-13"
slug: "/introducing-kortix"
cover: "/banner.png"
---
Every company is being told to "adopt AI." But most AI tools stop at the conversation. You ask a question, you get an answer, and the moment you close the tab the work is gone. That is a faster way to think. It is not a company running on AI.

Kortix is the **open-source AI Operating System for the agents that do your work**: one place to build a workforce of agents, connect them to your tools, run them on your terms, and keep every result accountable to a human.

Underneath that is an idea we think is right for the next decade of software: **your company's AI operation should be files in a git repo.** That means files you own, version, review, and run, rather than a pile of settings in someone else's dashboard.

## A company is a git repo

In Kortix, a **project** is one git repository. The repo \*is\* the project: its files, its history, its agents, its automations, its settings, all of it lives in git. Start fresh with a private repo Kortix hosts for you, or bring an existing one on GitHub.

- **Every change is reviewable.** A new automation, a tweak to an agent, a newly connected tool, each is a diff someone can read and approve before it goes live.
- **Nothing drifts.** There is no separate database of settings to fall out of sync with reality. The repo is the truth.
- **It is portable and yours.** Your whole setup is plain files. Read it, fork it, move it, run it on your own infrastructure.

> A company that runs on AI shouldn’t be a dashboard you rent and can’t inspect. It should be a codebase you own.

## kortix.yaml: the single source of truth

At the root of every project sits one file: `kortix.yaml`. Any repo with a valid manifest at its root \*is\* a Kortix project: that file defines what the project is, what it’s allowed to do, and how it runs. Here’s a real one:

```
# kortix.yaml — the one file that defines this project.
kortix_version: 2

project:
  name: acme-ops
  description: Acme's operations command center.

# Secrets your agents need: names here, encrypted values in the vault.
env:
  required: [DATABASE_URL]
  optional: [STRIPE_API_KEY]

# The sandbox every task boots into — your image, your hardware.
sandbox:
  templates:
    - slug: ops
      dockerfile: Dockerfile.ops
      cpu: 4
      memory: 8

# Run work on a schedule — nobody has to kick it off.
triggers:
  - slug: weekly-health-report
    type: cron
    cron: "0 0 9 * * 1"
    prompt: Draft the weekly customer health report for review.

# A tool the agent can use — credentials stay in the platform, never here.
connectors:
  - slug: slack
    policies:
      - match: "*message*"
        action: require_approval
```

That’s a company’s operating setup in a few dozen lines. The scheduler reads `triggers:`, the sandbox builder reads `sandbox.templates:`, the connector layer reads `connectors:`. Edit it in the dashboard or from inside a session and changes round-trip through the same file, and the diff stays clean either way.

## What happens when you hand off a task

Day to day, you describe a task in plain language and get a finished result back. Here’s everything that happens underneath, from the moment you hit go:

- **A branch is cut.** The control plane opens a **session** and cuts a fresh branch from main. Your main line is never touched directly.
- **The sandbox boots.** An isolated sandbox comes up from a content-addressed snapshot of your image, clones the repo, and pulls git credentials on demand, so no long-lived token sits in the environment.
- **The agent works.** It reads and writes files, reaches your connected tools, and commits progress to the session branch.
- **It proposes the work.** When done, the agent opens a **change request**, a summary plus the exact diff, and hands it to you. It does not merge its own work.

The sandbox is disposable by design. When the session ends, the environment is thrown away, and only committed, merged work survives. Because each session is fully isolated, any number can run at once: yours, your teammates’, and your automated ones, none stepping on each other.

## Review is the only way in

The change request is the heart of the trust model. It’s the **only** path for a session’s work to reach your main line, for \*everything\* the agent touched: new code, a new skill, an edited automation, a change to the agent’s own instructions. You see the exact diff, with conflicts flagged up front. Until you merge, the work is proposed, not applied.

> An agent can have real autonomy inside its sandbox while having zero ability to change your company without a human saying yes. That’s the combination that makes handing agents real work sane.

## Tools without handing over the keys

Kortix connects your agents to the apps your team already uses: Slack, Gmail, Notion, Salesforce, and thousands more. When an agent uses a connected tool, **it never holds your credentials.** Each call is brokered server-side: the platform resolves the credential, runs the call, records it, and returns the result. The key never enters the sandbox.

And you govern every action with policy: each tool can **run**, **require approval**, or be **blocked**, matched by name, so you can let an agent read freely and pause it before anything sends, posts, or pays. Every call is audited.

## Self-hostable, open, and yours

When AI becomes how your company gets work done, the system running it stops being a tool and becomes infrastructure. Infrastructure you don’t own can be changed, repriced, or switched off without your say. So Kortix is **open-source and self-hostable**, and you can run the entire stack on your own infrastructure: one command brings up a production-style Kortix on your own machines, and the same CLI switches between our cloud and yours.

Because it’s all open, you can read exactly how isolation, review, and credential brokering work, rather than trusting a description. No lock-in: your projects are git repos, your config is plain files, and the platform running them is yours to host. (If you’re weighing Kortix against personal open-source agents like OpenClaw or Hermes, [personal AI agents vs a company OS](/blog/personal-ai-agents-vs-company-os) draws that line.)

## It compounds

Because your whole setup is version-controlled files, none of it resets tomorrow. Every agent you shape, every skill you teach, every tool you connect, every bit of memory your agents carry forward accumulates in the repo and gets more capable week over week. The routine work that used to fill calendars runs quietly in the background, around the clock, and your team spends its time on the decisions that need a human. For the architecture that makes that compounding safe (state kept out of the model, identity and isolation as first-class, durable review): the [AGI-ready architecture post](/blog/agi-ready-architecture) is the deeper read.

Open Kortix and hand an agent a real task. Connect your first tool and watch it come back with something you can use. Free to start, free to self-host. [Try Kortix](https://kortix.com)
