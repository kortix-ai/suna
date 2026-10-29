---
title: "Kortix vs Hermes: one operator approves a skill write, a team needs a change request"
description: "Hermes stages its own skill writes for your approval and keeps a ledger of them. Open-source Kortix puts that review in a repo a colleague can approve."
date: "2026-10-11"
canonical: "https://kortix.com/blog/kortix-vs-hermes"
author: "team"
tags: ["Comparisons"]
updated: "2026-10-22"
slug: "/kortix-vs-hermes"
---
Hermes Agent already asks before it keeps what it learned, holding every skill write in `~/.hermes/pending/skills/` for `/skills diff` and `/skills approve` and logging each mutation to an append-only ledger, while Kortix, the open-source AI Operating System, puts that same review in a git repo where the approver can be someone other than the person who asked. Add a second colleague and the question becomes whose approval it is, and where the record lives.

```logos
label: 'Compared here:'
items:
  - { name: Hermes Agent, domain: nousresearch.com }
```

## What Hermes gets right

Hermes is a personal agent from Nous Research, released under the MIT license. Its learning loop is the part worth studying ([Hermes repository](https://github.com/nousresearch/hermes-agent)).

- **It writes the skill it was missing.** After a complicated task Hermes saves a new skill, revises that skill on later runs, and keeps memory across sessions, so the second attempt at a job goes faster than the first.
- **It can hold every skill write for you.** `skills.write_approval: true` stages each create, edit, patch and delete under `~/.hermes/pending/skills/` instead of committing it. `/skills pending` lists what is waiting, `/skills diff <id>` shows the change, and `/skills approve <id>` or `/skills reject <id>` settles it. That covers writes from the background self-improvement review, and `memory.write_approval` gates memory the same way ([skill writes](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills#gating-agent-skill-writes-skillswrite_approval), [memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)).
- **It keeps a ledger of who changed what.** Every skill mutation appends one entry to `~/.hermes/skills/.curator_ledger.jsonl`: the actor, the action, and a before and after hash for each file. `hermes curator rollback <entry-id>` undoes one mutation, and a snapshot undoes a whole run ([curator](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator)).
- **Seven terminal backends.** Local, Docker, SSH, Singularity, Modal, Daytona and Vercel Sandbox, with Daytona and Modal hibernating while idle ([Hermes README](https://github.com/nousresearch/hermes-agent)).
- **One gateway, twenty-plus chat platforms.** Telegram, Discord, Slack, WhatsApp, Signal, email and Teams among them, behind the same memory ([Hermes docs](https://hermes-agent.nousresearch.com/docs)).

Both gates ship off: a fresh install writes skills and memory freely, including from the background review.

## Where one operator's gate stops

Each default suits a single owner. Put a second colleague on the same agent and the limits show up.

- **The approval is a tier, not a reviewer.** Hermes's gateway sorts every allowed person into an admin or a regular-user tier, per platform and per scope, DM and group channel alike; an admin can run any slash command, `/skills approve` among them, so a colleague holding admin can settle a write someone else asked for ([messaging](https://hermes-agent.nousresearch.com/docs/user-guide/messaging)). Nothing separates the two jobs: no reviewer role, no change request, and no record that a second person read the diff.
- **The ledger is a record, not a gate.** Hermes's own docs put it plainly: the ledger "is telemetry, never a gate", and a mutation still goes through if writing the entry fails. It tells you afterwards who changed what. It does not hold the change for a signature.
- **The trail stays with the install, not the repo.** Hermes does read project skills from `<project-root>/.hermes/skills/`, at higher precedence than the profile folder, so a repo can carry its own ([skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)). What a colleague who clones that repo does not get is the trail: the staged writes under `~/.hermes/pending/skills/`, the ledger, and every new skill the agent creates, which always lands in `~/.hermes/skills/` on the machine that ran it.
- **Approval covers a write, not a call.** A staged skill write can stop for a person. A connector call cannot be limited to one customer record without custom work.
- **Nothing names the teammate.** The ledger's actors are curator, agent and user, which answers what kind of thing made the change. It does not answer which colleague signed off on it.

Hermes set out to be a personal agent, and for that job these defaults are right.

## A review gate needs a repo underneath

Reviewing an agent's work assumes the work has a readable shape, and that the reader can be someone else. In Kortix the project is that shape. Agents, the skills they load, company memory, connector grants and triggers live as files in a git repo the company owns ([Kortix on GitHub](https://github.com/kortix-ai/suna)).

```yaml
# kortix.yaml
kortix_version: 2
default_agent: support-triage
agents:
  support-triage:
    file: agents/support-triage.md
    connectors: all
triggers:
  - slug: daily-digest
    type: cron
    agent: support-triage
    cron: '0 0 9 * * 1-5'
    timezone: UTC
    prompt: Summarize yesterday's tickets and open a change request.
```

Those lines hold the agent's governance and its schedule. `agents/support-triage.md` holds how it behaves, and `connectors` says it may reach every connected app. At nine on weekday mornings the trigger summarizes yesterday's queue and opens a change request with the result. A new teammate clones the project and inherits all three. When the agent wants a different schedule or a narrower reach, a reviewer reads the diff of this block and of any skill it rewrote.

That reviewer is the difference. In Hermes the approver is an admin of that gateway scope, and the record of what was approved sits on the machine that ran the task. Here the diff lives on a branch, the request is addressed to the project, and whoever holds merge rights can read it.

## What a session leaves for review

One isolated sandbox per session. Each session has its own isolated machine and branch. What the agent installs or breaks stays in the sandbox, and the branch carries its work forward. Session work reaches `main` through a change request. Merge is default-deny for agents, so a request lands only once someone with merge rights approves it.

The diff for the support agent stays small: a trigger moves an hour, a connector is added, and a skill the agent rewrote appears as an edit with its old text beside the new. A reviewer reads those diffs, then merges or closes the request. The approval lands on the change request and in the [audit log](https://kortix.com/docs/audit-actions) as a `change_request.merge` event. A merge commit, when the merge needs one, is authored by Kortix ([git and change requests](https://kortix.com/docs/git)).

Where Hermes keeps a hash of before and after, Kortix keeps the change itself on a branch a person can read, comment on and leave unmerged. The change request also carries a decision by somebody other than the operator.

## What the gate costs

The review gate comes with the product, wherever you run it. Run it on Kortix Cloud, in your VPC, or on your own on-prem network. Self-host is free. The cloud bills credits. A reviewer who never runs an agent still needs an account. As published on [Kortix pricing](https://kortix.com/pricing), checked October 2026:

Free is $0 with 500 credits per month, every feature and 1 project, on the user's own provider keys or ChatGPT subscription. Managed models are on the Credits plan only. The paid plan is credits at one rate: 100 credits per dollar, so 5,000 credits a month costs $50. A larger monthly amount buys more credits, never a cheaper credit.

Members are unlimited and free, and the account shares one credit pool. Unused monthly credits roll over one month. A reviewer adds no charge. The pricing page puts the last piece plainly: "Credits pay for the agent computer." Model usage goes straight to your provider on your own keys.

## Where Hermes is the better tool

One person who wants an assistant that learns their habits can install Hermes on a machine they run, switch write approval on, and stop there. It answers in Telegram, keeps its own ledger without a repo, and asks nothing of a reviewer who does not exist. Seven backends and a portable skill format give Hermes reach Kortix Cloud does not have.

## Side by side

Both columns follow each project's own documentation in October 2026: [Hermes on GitHub](https://github.com/nousresearch/hermes-agent) and the [Hermes docs](https://hermes-agent.nousresearch.com/docs), against [Kortix on GitHub](https://github.com/kortix-ai/suna) and [Kortix pricing](https://kortix.com/pricing).

```compare
them: Hermes
rows:
  - dimension: Open source
    them: Yes, MIT licensed
    kortix: 'Yes, self-host or managed cloud'
    lean: both
  - dimension: Built for
    them: One person, on a machine they run
    kortix: A team working from one repo
    lean: both
  - dimension: What you own
    them: The agent, its skills and memory on one install
    kortix: Agents, skills, memory and connectors as files in one git repo
    lean: kortix
  - dimension: Who can use it
    them: Allowlists, DM pairing, and admin/user tiers per platform scope
    kortix: 'Roles, groups, and an audit trail; SAML 2.0 single sign-on and SCIM 2.0 (Enterprise plan)'
    lean: kortix
  - dimension: Approval of self-edits
    them: An admin approves staged skill and memory writes
    kortix: A colleague approves a change request
    lean: kortix
  - dimension: Audit and rollback
    them: Append-only ledger, one mutation at a time
    kortix: Every action recorded; reading the log depends on plan
    lean: them
  - dimension: Isolation
    them: Container backends and isolated subagents
    kortix: One isolated sandbox per session, on its own branch
    lean: both
  - dimension: Model choice
    them: Any provider or a local model
    kortix: Any provider, your keys
    lean: both
  - dimension: Price to start
    them: Free to self-host; optional Nous Portal subscription
    kortix: Self-host free; credits from $50 a month
    lean: both
```

## When to pick which

```verdict
themLabel: Hermes
them: You want one self-improving assistant on a machine you run, with write approval on, reached from the chat apps you already use.
kortix: You want the agents, memory and connectors in one repo a colleague reviews, each task on its own sandbox.
```

Next reads: [Personal AI agents vs a company OS](/blog/personal-ai-agents-vs-company-os) and [Kortix vs AnythingLLM](/blog/kortix-vs-anythingllm).

Try [Kortix](https://kortix.com) on your own computer first. Self-host is free, and cloud sandboxes run on credits.
