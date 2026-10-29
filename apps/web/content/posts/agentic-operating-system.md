---
title: "An open-source agentic operating system is one whose permissions you can read"
description: "Most definitions of an agentic operating system stop at coordination, while an open-source one puts permission in a grant file you can read."
date: "2026-10-25"
slug: "/agentic-operating-system"
canonical: "https://kortix.com/blog/agentic-operating-system"
author: "team"
tags: ["Field notes"]
---
An agentic operating system decides which agent may act, and with whose credentials. Most definitions stop a step earlier, at coordination: agents, memory and tools arranged so work runs end to end. Coordination is easy to show; permission is the part you have to read. Kortix is the open-source AI Operating System, and its permission layer is a manifest in the repository.

## An operating system hands out a scarce resource and can refuse

Every operating system does two jobs. It allocates something bounded, such as processor time or memory, and it enforces a boundary when a process asks for what it was not given. The classical abstractions that carry those jobs are processes, system calls, files and permissions. They "assume bounded behavior and predictable interaction patterns", as a June paper on Agent Operating Systems puts it ([arXiv:2606.01508](https://arxiv.org/abs/2606.01508)).

Agents supply neither. They run for hours, choose tool calls and change course on what comes back. The paper's answer is an agentic control plane inside the OS, split into schedulers, memory, tool registries, "policy and trust enforcement", and audit.

For agents the scarce resource is permission: reach into a tool, a credential, a branch. A system that orders that work but cannot deny a call is a scheduler. The deny path is what makes it an operating system. It also gives a reviewer four things to ask for: the resource, the allocator, a refusal and the record.

## What the pages that define the term actually say

MindStudio calls an agentic OS "a structural pattern" rather than software you install ([mindstudio.ai](https://www.mindstudio.ai/blog/what-is-agentic-operating-system)). It draws the OS analogy itself: an operating system "doesn't do the work itself".

Slack's guide calls it "an operating layer for AI" that "coordinates autonomous agents, connects them to your data and apps, and keeps humans in control of outcomes" ([slack.com](https://slack.com/blog/productivity/what-is-an-agentic-os)). Its components include guardrails on what agents can access, and audit trails.

AIOS, a research project, takes the kernel analogy literally. It is "the AI Agent Operating System", whose kernel sits above the host OS "managing various resources that agents require, such as LLM, memory, storage and tool" ([github.com/agiresearch/AIOS](https://github.com/agiresearch/AIOS)).

Lyzr drops the analogy on purpose: "an agentic OS means an enterprise AI agent orchestration platform", and "we are not talking about Windows, Linux, or macOS" ([lyzr.ai](https://www.lyzr.ai/blog/best-agentic-os-platforms)). It is sharper about enforcement: governance should be "deterministic, enforced at the infrastructure level, rather than probabilistic, embedded in prompts that can be circumvented". A control plane carries the RBAC policies, the audit trail and the kill switch.

Four of the five name a place where reach gets decided, and one treats the system as a pattern with no single home. None hands a reader the grants to inspect.

## A prompt is not a control

The difference between a control and an instruction is who checks it, and when. A prompt that tells an agent to stay out of production is read by the model while it generates a call, which makes it advice to the actor. A grant is checked by something that is not the model, at the moment the call is made, and that check can refuse the call.

Lyzr's guide draws the same line: governance written into a prompt can be circumvented. If the only place an agent's limits are written is its prompt, the model is both the actor and the guard.

Permission has three parts, and a system that documents one is guessing. Reach is which tools and skills an agent may call. The credential is what a call can spend. Effect is what the work can change: a branch, a merge, a production system.

## Four questions the permission file has to answer

A new Kortix project starts from a public starter manifest, `packages/starter/templates/base/kortix.yaml` in the repository ([Kortix on GitHub](https://github.com/kortix-ai/suna/blob/dev/packages/starter/templates/base/kortix.yaml)). It is a `kortix_version: 2` manifest, and its header marks the `agents:` map "GOVERNANCE ONLY": the block carries the connectors, secrets, permissions, skills and workspace grants, plus the agent's `.md` path. Behavior lives in markdown; reach lives here.

The schema is deny-by-default: an omitted grant resolves to none, so a scoped specialist starts locked down. The starter's own agent is granted "all" so a fresh project runs, and a comment says to narrow it once you know what the project needs.

```yaml
# packages/starter/templates/base/kortix.yaml
kortix_version: 2
agents:
  kortix:
    file: agents/kortix.md
    connectors: all
    secrets: all
    kortix_permissions: all
    skills: all

  harness-reflector:
    file: agents/harness-reflector.md
    kortix_permissions: all
    skills: all
    workspace: { project_repository: true }
```

The first block exists so a new project runs. The second is what an unattended decision looks like in the same file.

- **Who can widen an agent's reach, and who reviews it.** Widening means editing a grant line here, and the edit needs `project.agent.write` ([agents and permissions](https://kortix.com/docs/project/agents)). Session work reaches `main` through a change request, and merge is default-deny for agents. On a v2 manifest, the dashboard and CLI paths commit `kortix.yaml` straight to the default branch, so anyone holding that permission can widen a grant with no diff and no approval. That is the one path the diff test does not cover.
- **What an unattended session can reach.** The `harness-reflector` is a scheduled agent: it reads recent sessions, refines the harness and opens a change request it never merges. It needs `kortix_permissions: all`, because a scoped grant 403s the CLI reads it needs while nobody is present to widen it. It gets no connectors and no project secrets, which the file explains in three words: "nothing to exfiltrate."
- **Where the credential sits relative to the command.** The default agent holds `secrets: all`. A granted secret arrives in the session as an environment value, so any command can read it. Connector credentials are brokered server-side and never enter the machine.
- **What record survives the session.** Every action is recorded, and reading, exporting and streaming the audit log depend on the plan. The work lands as a branch and a change request, so the diff outlives the machine.

## What this rules out

A system whose grants live only in an admin console fails three of the four questions. A click leaves no diff to read, and the record is exported on the vendor's terms. What an unattended job can reach changes when someone edits a screen, with nothing in the repository to show it.

A role is a bundle, not a grant: it says someone is an editor without saying which credential their agent can spend.

Nothing in the test requires open source. A closed product can enforce deterministic permissions. What open source changes is what a reviewer takes on trust. The enforcement code and the grant file can both be read, so the diagram and the deployment can be compared.

## What to ask any agentic OS vendor

The test is also the shortlist. The system you want is the one whose grants you can read before you deploy it, and whose refusals you can find in a log.

- **Show me the file where grants live.** A file with an author and a history, not a screenshot of a settings page.
- **Show me a refusal.** A call the system denied, and the log line that recorded it.
- **Show me an unattended job.** What it can reach at three in the morning, and who decided that.
- **Show me where a secret sits while the command runs.** Whether it is inside the session, or outside it and substituted at the boundary.
- **Show me how a permission change landed.** A change request with a diff, or a direct commit from the dashboard, and who holds `project.agent.write`.

A vendor that answers all five from a repository you can clone is selling an operating system. One that answers from slides is selling orchestration.

Building one runs in the same order. Write the grants first, one block per agent with the default at none, then the agent files, then the trigger that starts them unattended. Keep git underneath, so every widening arrives as a diff. Read the starter manifest before you trust anyone's diagram; the grants sit at the top of it, beside the one agent that gets everything. If that reads like a system you would sign, [Try Kortix](https://kortix.com).
