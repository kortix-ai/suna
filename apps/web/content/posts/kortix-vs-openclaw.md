---
title: "Kortix vs OpenClaw: what a review gate should cover"
description: "OpenClaw reviews a repository change; Kortix, the open-source AI Operating System, reviews the repo that defines the company, with merges gated by grant."
date: "2026-10-04"
canonical: "https://kortix.com/blog/kortix-vs-openclaw"
author: "team"
tags: ["Comparisons"]
updated: "2026-10-22"
slug: "/kortix-vs-openclaw"
---
OpenClaw is a strong open-source personal assistant, and Kortix is the open-source AI Operating System: your agents, their skills, your company memory, and every connector in one git repo you own. OpenClaw now ships shared sessions, managed worktrees, a checkout diff, Publish PR and an audit ledger, so the question is no longer whether an assistant can be reviewed. It is what the review covers, and who may pass it.

```logos
label: 'Compared here:'
items:
  - { name: OpenClaw, domain: openclaw.ai }
```

## What OpenClaw already gets right

[OpenClaw](https://github.com/openclaw/openclaw) installs on your own computer and reaches you through Discord, iMessage, Slack, Microsoft Teams, Telegram, WhatsApp and 20+ more channels, plus native apps for macOS, iOS, Android, Windows and Linux. The source is public, and state, memory and credentials stay on your hardware. Its team mode carries more review machinery than its reputation suggests.

- **Shared sessions with attribution.** Everyone with access can open and steer the same session, and each one carries an immutable creator, an assignable owner and the history of who prompted it. Commits carry co-author credit, and a pull request links back to the conversation that produced it ([team setup](https://docs.openclaw.ai/start/teams)).
- **A branch and a checkout per task.** Managed worktrees give an agent task its own git branch and checkout, recorded in the shared state database and snapshotted before cleanup ([managed worktrees](https://docs.openclaw.ai/concepts/managed-worktrees)).
- **A diff, tests, then a pull request.** A reviewer inspects the agent's results and the checkout diff, runs the relevant tests, resolves findings and publishes through Publish PR. The publication does not merge ([team server](https://docs.openclaw.ai/gateway/team-server)).
- **Roles and per-session permission modes.** Roles bound which sessions a person can touch, which agents they can use and whether their sessions must be sandboxed. A session runs read-only, guarded, workspace or full, and guarded and workspace modes route escalations to a reviewer ([permission modes](https://docs.openclaw.ai/gateway/permission-modes)).
- **An audit ledger.** The Gateway keeps a bounded, metadata-only ledger of identity, ordering, provenance, action, status and outcome codes, and turns operator approvals into decision receipts ([audit](https://docs.openclaw.ai/gateway/audit)).
- **No vendor in the middle.** MIT-licensed and [free of a paid tier and a hosted service](https://openclaw.ai), stewarded by an independent 501(c)(3).

## Where the gate stops

Three limits matter once the work belongs to a company rather than a repository.

**One Gateway is one trust domain.** OpenClaw says so plainly: everyone who can message a tool-enabled agent shares that agent's delegated tool authority, and roles are "collaboration guardrails inside the boundary, not isolation between adversaries". Tenants that do not trust each other need separate Gateways. That is a reasonable line for a team that already trusts its members, and it puts the boundary around the machine rather than around a role.

**The thing under review is a repository task.** Worktree, diff, tests, pull request. Publication does not merge, and the base branch stays safe because you protect it "with GitHub rules so the shared account cannot merge". The merge decision therefore lives in the git host and in the GitHub identity behind one shared account, not in the rules that govern what an agent may do.

**Several files sit outside the diff.** Personal skills stay personal until someone shares them with the team. Shared Gateway configuration is changed through operator access, not through a reviewed change. The audit ledger records that a run happened, which tool actions it took and how it ended, and by design it stores no prompts, no tool arguments, no results and no filenames. A team can reconstruct the decision to approve, and not the content that was approved.

For an assistant a team shares, that design holds together. It leaves one gap a company feels: the files that decide what the agents may do are not the files being reviewed.

## One repo that is the system

Kortix runs a company's agents out of that repository, on the same branches your engineers already use. The manifest, the agent prompts, the skills, the memory files, the connector grants and the triggers all live there. [Kortix on GitHub](https://github.com/kortix-ai/suna) is where the platform itself lives. One isolated sandbox per session. Each session has its own isolated machine and branch.

Picture two engineers on a Friday. One widens a connector grant so an agent can file invoices. The other rewrites that agent's instructions for the same job. Both open change requests, and a reviewer reads them together, sees that the permission change is unrelated to the rewrite, and asks for it to be argued on its own. What matters is what sits in the diff: the company's operating rules as well as the code an agent touched.

Run it on Kortix Cloud, in your VPC, or on your own on-prem network. Free to start, free to self-host. See [Kortix pricing](https://kortix.com/pricing).

## Merge is a grant, not a habit

Session work reaches `main` through a change request. Merge is default-deny for agents. A person with `project.gitops.merge` reads the change request and merges it. A session can merge a change request it opened only when its agent's grant in `kortix.yaml` includes `project.gitops.merge`, and the starter agent ships with every permission, so the first job on a new project is to take the merge away from the agents that should not have it.

```yaml
kortix_version: 2
agents:
  support:
    file: agents/support.md
    connectors: [helpdesk]
    skills: [kortix-cli, triage]
    kortix_permissions: [project.session.read, project.review.submit, project.gitops.push]
```

That agent can push and open a change request, and cannot merge one: the list holds `project.gitops.push` and stops short of `project.gitops.merge`. Add that permission and it can merge. The rules stack: a merge that changes `agents` or `default_agent` also needs `project.agent.write`, and an agent can only grant what it already holds, so a session cannot hand itself a capability it was never given ([agents and permissions](https://kortix.com/docs/project/agents)).

This is where the two products diverge: the grant, rather than the reader's job title, decides who merges. Close attention to that list is the whole discipline. The starter agent holds `all` until somebody narrows it, and a team that never edits that list has an agent that can merge its own work.

## Where OpenClaw is the better pick

One person who wants an assistant in every chat app today should take OpenClaw. It installs with one command on hardware you already own, its native apps and channel coverage reach further, and there is no project, role or grant list to configure before the first useful answer. Kortix asks a team to set up a repository, decide who may merge and keep the permission list honest. That is the cost of the gate, and solo work does not need it.

## Side by side

```compare
them: OpenClaw
rows:
  - dimension: Open source
    them: Yes, MIT
    kortix: Yes, self-host or managed cloud
    lean: both
  - dimension: Scope
    them: A personal assistant, shareable with a team
    kortix: Agents, skills, memory, connectors and triggers
    lean: kortix
  - dimension: Where it runs
    them: Your machine or a team server you host
    kortix: Kortix Cloud, your VPC, or your on-prem network
    lean: both
  - dimension: Configuration lives in
    them: Gateway config and workspace files
    kortix: One git repo your team owns
    lean: kortix
  - dimension: What a review covers
    them: An agent's repository change
    kortix: Agent, skill, memory, connector and trigger changes
    lean: kortix
  - dimension: Merge gate
    them: GitHub branch rules on a shared account
    kortix: project.gitops.merge, denied to agents by default
    lean: kortix
```

## Which one you need

```verdict
themLabel: OpenClaw
them: You want one assistant that follows you into every chat app and stays on your own machine.
kortix: You want the company's own files under review, with merge denied to agents until you grant it.
```

If you are still mapping the field, [Kortix vs OpenHands](/blog/kortix-vs-openhands) covers the coding-agent side of the same decision, and the [Kortix blog](/blog) has the rest of the comparisons.

Start with one project at no cost. [Try Kortix](https://kortix.com).
