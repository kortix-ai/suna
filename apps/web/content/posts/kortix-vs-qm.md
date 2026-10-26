---
title: "Kortix vs QM: both open source, one organizes work around rooms, the other around branches"
description: "QM and Kortix both give teams persistent agents, isolated computers, Slack and web access, and self-hosting. The decisive difference is deeper: QM organizes work around people and rooms; Kortix organizes it around git-backed projects and reviewable sessions."
date: "2026-08-02"
canonical: "https://kortix.com/blog/kortix-vs-qm"
author: "marko"
tags: ["Comparisons", "Architecture", "Open Source"]
updated: "2026-10-21"
slug: "/kortix-vs-qm"
coverLogos: [{"domain": "github.com", "name": "QM"}]
cover: "/banner.png"
---
QM is a serious bet that an AI colleague belongs to a person or a room. Kortix, the open-source AI Operating System, bets that work belongs to a repository, and that each session's result should be reviewed before it lands. Both are multiplayer, both keep state outside the model, and both hand the agent a real computer. What separates them is the unit of work a company organizes around.

QM details come from its main branch at [`f5d40e7`](https://github.com/yc-software/qm/tree/f5d40e73f39730bc383768d5fda67759a3166eaa), its [README](https://github.com/yc-software/qm/blob/f5d40e73f39730bc383768d5fda67759a3166eaa/README.md) and [spec](https://github.com/yc-software/qm/blob/f5d40e73f39730bc383768d5fda67759a3166eaa/docs/SPEC.md) at that commit, and the [`@yc-software/qm` `0.1.15` package](https://www.npmjs.com/package/@yc-software/qm), published 2026-10-20. Kortix details come from [its project docs](https://kortix.com/docs/project/agents). Both were checked in October 2026.

```logos
label: 'Compared here:'
items:
  - domain: github.com
    name: QM by yc-software
```

## Rooms against branches

```
QM
person or room -> scope -> persistent memory + files + computer
               -> conversations, schedules, credentials, published apps

Kortix
git project -> session -> isolated computer + session branch
            -> agent work -> change request -> reviewed merge to main
```

For QM the unit is the scope. A person, a Slack channel, a group message or a project room each get a durable scope, and that scope owns memory, files, credentials, schedules, skills and a computer. Kortix's unit is the project, which is a git repository plus `kortix.yaml`. A session takes a branch and a sandbox, and durable work returns as a change request.

> Continuity is QM's promise: a colleague that remembers the room. Auditability is Kortix's: a company where you can see which agent changed what, and who accepted it.

## Persistence: a warm room or a readable repository

QM keeps sessions, memory, queues, grants and audit data in Postgres. Each scope also gets a durable workspace and home directory, so a resident computer keeps installed tools and CLI logins warm between turns. Artifacts cross from one scope to another only through an explicit grant.

Kortix splits that job in two. Supabase Postgres holds accounts, projects, sessions, sandboxes, triggers, grants, audit events, usage and gateway logs. The project repository holds the agents, skills, memory, policies and runtime configuration that people edit and review, and runtime state sits outside `/workspace` so it never mixes with the company's files.

So QM optimizes for continuity of a colleague and a room, and Kortix optimizes for diff, rollback and promotion to `main`. A room accumulates context that nobody reviews. A project can show the change and the person who approved it.

## A computer per room, or a computer per session

QM assigns a durable computer to a scope. On [Fly](https://github.com/yc-software/qm/blob/f5d40e73f39730bc383768d5fda67759a3166eaa/cli/templates/deployment/references/fly.md) the core and each sandbox run as Machines in the operator's own organization, beside private object storage. On [AWS](https://github.com/yc-software/qm/blob/f5d40e73f39730bc383768d5fda67759a3166eaa/cli/templates/deployment/references/aws.md) the agent computers are Lambda MicroVMs, and a home snapshot is kept in S3. Tools installed once stay installed, which is what a daily colleague needs.

Kortix assigns a computer to a session. One isolated sandbox per session. Each session has its own isolated machine and branch. Platinum is the reference provider, and new sessions land there through a single provider interface. The control plane extends a sandbox deadline when a turn starts, when the gateway carries model traffic, or when an authenticated preview is hit, and a finished turn drops the deadline to the idle grace period. An open session page, by a person who may start sessions, [keeps the sandbox awake](https://kortix.com/docs/work/sessions) for 15 minutes after their last interaction and is renewed while the tab is visible, up to 2 hours past the last turn. What never counts is a request the sandbox makes itself, since only its LLM calls through the gateway renew it.

Neither lifetime is better in the abstract. A scope that stays warm spares an everyday colleague the setup ritual. A session that starts clean bounds the blast radius and gives concurrent work its own branch.

## Screening content, or authorizing an identity

QM picks one posture per organization, and a narrower scope can only tighten it. **Strict** pauses every harness tool call for human approval. **Auto**, the default, blocks private-network access. **Dangerous** removes the approval gates and caps content screening at observe. Screening is a deployment setting of its own, `securityScreen.mode`, which stays off unless an operator turns it on, and the predeclared command policy applies in every posture, Dangerous included.

Kortix starts from identity. Authorization runs on the principal, the project, the session, the agent's grant and the action. Connector credentials are brokered server-side and never enter the machine. Project secrets are a different case: an explicitly granted secret is injected as a real environment value, and any command in that session can read it. Connector policies decide allow, ask or block, and session work reaches `main` through a change request. Merge is default-deny for agents.

QM spends its policy on what reaches the model and what a tool call may do. Kortix spends it on who is acting, and on whether durable work reaches the shared branch.

## A swappable harness, or one contract for every client

QM treats the harness as an interface. [Pi and Claude Code both drive the same core](https://github.com/yc-software/qm), and the spec says a turn can be fulfilled by either. An operator can change the model loop without touching identity, memory, delivery or the sandbox system.

Kortix spends that design budget on the client contract. Every client reads a session through the same session API, so the web app, the CLI, a mobile build and a white-label host share one surface. A client builds against that contract, and the harness sits behind it.

QM wins when harness interchangeability is the requirement. Kortix wins when many clients need one stable surface.

## Side by side

```compare
them: QM
rows:
  - dimension: Primary unit
    them: Person or room scope
    kortix: Git-backed project and session
    lean: both
  - dimension: Collaboration model
    them: Shared room memory and computer
    kortix: Shared project, isolated session branches
    lean: both
  - dimension: Computer lifetime
    them: Persistent per scope
    kortix: Isolated per session
    lean: both
  - dimension: Agent runtime
    them: Pi or Claude Code
    kortix: OpenCode
    lean: them
  - dimension: Durable write path
    them: Scope store and resident computer
    kortix: Commit and reviewed change request
  - dimension: Security policy
    them: Strict, Auto, or Dangerous posture
    kortix: Per-action allow, ask, or block
    lean: both
  - dimension: Hosted sandboxes
    them: Fly Machines or AWS Lambda MicroVMs
    kortix: Platinum (reference provider)
    lean: both
  - dimension: Open source
    them: Yes, MIT
    kortix: Yes, self-host or managed cloud
    lean: both
```

## Migration remaps the unit of work

There is no drop-in migration, because the two systems disagree about what the durable thing is. Leaving QM means turning scopes into projects, scope skills and memory into repo files, crons into triggers, keychain entries into connectors or secrets, and live work into sessions. The real decision is which room-local state belongs in version control and which should stay operational.

Going the other way is quicker to describe and harder to run. Projects and teams become scopes, agents and skills move into a deployment layer, triggers become crons, and app publishing replaces change-request promotion. The branch-per-session review gate disappears unless someone rebuilds it as a skill and a policy.

## When the room is the product

```verdict
themLabel: QM
them: your core product is a persistent AI colleague for every person and Slack room, you value interchangeable harnesses, and you want resident computer state.
kortix: your core product is a versioned company or a customer project, you need isolated concurrent sessions, reviewed change requests, a published SDK and CLI, and managed cloud plus self-hosting.
```

QM is MIT-licensed, and Kortix is open source. Pick QM when the room is the product and continuity is the feature your people feel. Pick Kortix when the repository is the product and every durable change should arrive as a reviewable diff. Running both is possible in principle, with QM holding the conversational scope and Kortix running project sessions behind it, but that adapter has to carry identity, grants and delivery provenance across two systems. Treat it as a connector project, not a configuration flag.

```cta
title: Put the project model to work.
body: Create a Kortix project, start an isolated session, and review the change your agent brings back. Self-host it or use Kortix Cloud.
```
