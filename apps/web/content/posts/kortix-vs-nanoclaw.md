---
title: "Kortix vs NanoClaw: who reviews the file that defines the open-source agent"
description: "NanoClaw runs a personal AI agent in a Docker container; Kortix is the open-source system a company owns and reviews."
date: "2026-10-13"
canonical: "https://kortix.com/blog/kortix-vs-nanoclaw"
author: "team"
tags: ["Comparisons"]
updated: "2026-10-25"
slug: "/kortix-vs-nanoclaw"
---
```logos
label: 'Compared here:'
items:
  - { name: NanoClaw, domain: nanoclaw.dev }
```

NanoClaw is a lightweight personal AI agent that runs every session in its own Docker container and meets you in the chat apps you already use; Kortix is the open-source AI Operating System a team owns. Work an agent does reaches `main` through a change request a person merges, and merge is default-deny for agents. Both are open source, and both let you bring your own model. The separation between them is what each is built to hold: one person's private agent, or a workforce a company governs.

## What NanoClaw is good at

NanoClaw is a small, security-first agent harness from NanoCo, built to be small enough that one person can understand and change it. It is MIT-licensed ([NanoClaw on GitHub](https://github.com/nanocoai/nanoclaw)). Its own site describes the same core functionality as larger claws in a codebase a person can read in an afternoon ([NanoClaw](https://nanoclaw.dev)).

- **Every session is isolated.** Each active session runs in its own Docker container and can only see what is explicitly mounted, on macOS, Linux, or Windows through WSL2 ([NanoClaw](https://nanoclaw.dev)).
- **The core is small on purpose.** One Node host process routes each message, with no microservices and no message brokers, so you can trace a message from the channel to the agent and back ([NanoClaw on GitHub](https://github.com/nanocoai/nanoclaw)).
- **Agents do not hold raw keys.** Outbound HTTPS routes through a credential gateway that injects credentials at request time and enforces per-agent policies and rate limits, and NanoClaw ships with OneCLI's Agent Vault behind a provider seam ([NanoClaw on GitHub](https://github.com/nanocoai/nanoclaw)).
- **It reaches the chats you use.** WhatsApp, Telegram, Discord, Slack, Microsoft Teams, iMessage, Matrix, Google Chat, Webex, Linear, GitHub, WeChat, and email through Resend, each added on demand ([NanoClaw on GitHub](https://github.com/nanocoai/nanoclaw)).
- **The model is a per-agent choice.** Claude is the default through Anthropic's Claude Agent SDK, with Codex, OpenCode, and Ollama as drop-in providers ([NanoClaw on GitHub](https://github.com/nanocoai/nanoclaw)).

That combination is tuned for a single operator running one agent on their own machine.

## Where the open-source install stops for a team

NanoClaw's repository states that it has no user accounts. Its design notes describe software that fits one user's exact needs, not a multi-tenant platform ([NanoClaw on GitHub](https://github.com/nanocoai/nanoclaw)). That describes the install, the code you clone and fork. NanoCo, the maintainers, sell something else for teams. A banner on nanoclaw.dev announces a $12M raise to give every member of your team a professional assistant ([NanoClaw](https://nanoclaw.dev)), and nanoco.ai describes agents for organizations with centralized access control and governance ([NanoCo](https://nanoco.ai)). Sensitive actions there need human approval and are fully audited under policies the organization controls. It runs inside the organization's AWS, GCP or Azure account.

- **One configuration.** Customization means code changes to your own fork, so there is no shared company repo that a team diffs and reviews together.
- **No accounts to hand out.** A second person does not get a login to the install; an assistant for each member of a team is what NanoCo's organization product offers ([NanoCo](https://nanoco.ai)).
- **Memory stays per group.** Each agent group keeps its own workspace and memory, and separate groups do not share one, so what the company learns sits in a single operator's fork.
- **One host.** A single Node process on your machine is the whole system, and the machine is where the agent runs.

Those four properties are what make the install good for one person. They also set where it stops. A change to an agent is a commit to the operator's fork. A colleague who wants a say has to be handed the repository first.

## One repo that is the company

Kortix starts from the opposite unit: a team, with a git repo at the center. An agent is `agents/<name>.md` (behavior) plus an `agents.<name>` block in `kortix.yaml` (governance). Company memory is plain files today. `kortix.yaml` declares the machine image, connectors and triggers, and secret names and grants. Secret values never appear in the repo. The repo is the company, and you can grep all of it ([Kortix on GitHub](https://github.com/kortix-ai/suna)). Because the configuration is text, a team diffs a change to an agent's permissions or its memory. It reviews that diff like any other code.

```
agents:
  support-triage:
    file: agents/support-triage.md
    connectors: all
```

That block is the whole agent. Behavior sits in the markdown file, reach and governance in the manifest. Both land in a diff a reviewer can comment on.

## One machine per session, one review per change

Kortix is built so that work is reviewed before it lands. One isolated sandbox per session. Each session has its own isolated machine and branch, and thousands of agents run in parallel on one config, each on its own cloud computer. When the work is ready, the agent opens a change request against the default branch. A person reads the diff before it lands ([Kortix on GitHub](https://github.com/kortix-ai/suna)).

- **Per-resource permissions for people and agents.** Roles, groups, and an audit trail.
- **Every tool call is scoped.** Each connector action is Allow, Ask, or Block, decided at the level of a single call's arguments, and connector credentials are brokered server-side so they never enter the machine.

NanoClaw keeps one operator's agent private on their own machine. Kortix keeps a team's agents in a setup the team can audit, because it is the same repo the work lands in. The manifest is in the repo, and each session gets its own sandbox.

## Where NanoClaw is the better pick

If you are one person who wants a private agent on your own machine, NanoClaw is the lighter answer. It installs on macOS, Linux, or Windows through WSL2 and reaches a dozen chat surfaces. State and keys stay on your hardware, with no account to create. Nothing in the open-source install asks you to think about a colleague's access or a review gate, which is exactly what personal use wants.

## Side by side

```compare
them: NanoClaw
rows:
  - dimension: Open source
    them: Yes, MIT
    kortix: Yes
    lean: both
  - dimension: Built for
    them: One person and their machine
    kortix: A company's agent workforce
    lean: them
  - dimension: Where the agent runs
    them: On your own machine
    kortix: On its own cloud computer per session
    lean: them
  - dimension: Codebase size
    them: About 29,300 lines of TypeScript
    kortix: Not published
    lean: them
  - dimension: Changing an agent
    them: Edit the code in your fork
    kortix: A markdown file and its manifest block
    lean: kortix
  - dimension: What a review covers
    them: The code change in your fork
    kortix: The agent's behavior, grants and its work
    lean: kortix
  - dimension: How work lands
    them: Actions taken directly in your apps
    kortix: A change request a person merges
    lean: kortix
  - dimension: Permissions and audit
    them: No user accounts in the install
    kortix: Roles, groups, and an audit trail
    lean: kortix
```

## When to pick which

Pick NanoClaw when you are one person running an agent for yourself and you want the smallest codebase you can fork and shape. Pick Kortix when a team has to run agents together. The configuration is a repo people review, and the permissions, audit, and change-request gate exist for more than one person steering the work.

The unit is the difference. The open-source NanoClaw optimizes for one operator and their machine, and Kortix optimizes for a workforce a company owns and reviews.

[Kortix vs OpenClaw](/blog/kortix-vs-openclaw) covers the assistant side of this. [Personal AI agents vs a company OS](/blog/personal-ai-agents-vs-company-os) draws the line between one operator and a whole company.

Free to start, free to self-host. [Try Kortix](https://kortix.com).
