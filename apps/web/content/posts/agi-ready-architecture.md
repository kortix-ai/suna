---
title: 'AGI-ready architecture: what it really means, and how Kortix is built for it'
description: AGI-ready doesn't mean an architecture that produces AGI. It means one that absorbs a 100× capability jump without losing state or granting uncontrolled access. How Kortix is built for it.
date: '2026-07-17'
author: marko
tags:
  - Architecture
  - Vision
cover: /banner.png
canonical: https://kortix.com/blog/agi-ready-architecture
readingTime: 9
lead: Most “AGI-ready” claims are a model wrapped in tools. Swap that model for something a hundred times more capable and the whole thing breaks — or worse, it works, and you’ve quietly handed an uncontrolled agent your production, your money, and your customers. AGI-ready doesn’t mean an architecture that produces AGI. It means the surrounding platform can absorb major jumps in capability without being rebuilt.
---

The models will get better. That is the one safe bet in this entire field — more capable, more autonomous, multimodal, continuously active, able to run for days or months, able to control computers, infrastructure, and accounts, and eventually cheap enough to spawn thousands of concurrent workers. The question is not whether that happens. The question is whether your platform can take the jump without giving the model uncontrolled access, losing its state, or being rewritten.

> AGI-ready architecture is a durable, stateful, model-independent, permissioned, observable, evaluable, self-improving execution system for intelligent entities — not merely an LLM wrapped in tools.

## The test that matters

Here is the practical test: can you replace today’s model with something 100× more capable — more autonomous, multimodal, able to run for days, control computers and money, and fan out into thousands of workers — and keep the same identity boundaries, the same permissions, the same review gates, and the same state? If yes, the architecture is AGI-ready. If the model \*is\* the application, it isn’t. The model is a reasoning engine. The platform around it is the product.

## Models are replaceable — the reasoning engine is not the application

An AGI-ready system depends on capabilities — reason, code, vision, verify — not on a model name. Kortix treats models as hot-swappable reasoning engines behind a gateway. Bring any provider on your own keys, or run self-hosted inference on your own GPUs. Route a cheap open-weight model for the bulk of the work and a frontier model only where it earns its keep.

- **Any model, your keys** — Claude, GPT, Gemini, or open-weight GLM and DeepSeek; your subscription, your spend, your data residency.
- **A model-agnostic gateway** — per-project routing chains, ordered fallbacks, and semantic failover where an empty completion is classified as a failure, not a zero-output success.
- **Self-hosted inference** — run it in your own VPC or on-prem, on your own hardware. The platform never assumes a vendor is reachable.

When a better model ships tomorrow, you point the gateway at it. Nothing else moves.

## State lives outside the model

This is the single most important invariant, and it is the one most “agent platforms” violate. If the model’s context window is where your state lives, you have no state — you have a lucky streak that ends when the session ends. In Kortix, everything is files in a git repo. The manifest, the agents, the skills, the connectors, the policies, and the memory are all versioned, diffable, owned files. The model proposes; a trusted subsystem persists.

```
# kortix.yaml — one file that defines this project.
kortix_version: 2

project:
  name: acme-security-audit

# A tool the agent can use. Credentials stay in the platform,
# never in this file. The policy decides what needs a human.
connectors:
  - slug: slack
    policies:
      - match: "*message*"
        action: require_approval

# Run work on a schedule — nobody has to kick it off.
triggers:
  - slug: nightly-access-review
    type: cron
    cron: "0 0 2 * * *"
    prompt: Audit last night's access logs and flag any out-of-policy connector calls for review.
```

Crucially, nothing the model generates silently becomes authoritative business state. An agent can write code, draft a campaign, or move a file — but that change reaches the shared `main` only through a reviewed change request. The model’s output is a proposal until a human or a trusted gate says otherwise.

## Every action has an identity — and the model is never the authority on what it may do

Authentication answers who the agent is. Authorization answers what it may do — and the model must never be the final authority on the second question. In Kortix, every session runs under a scoped identity with a single token carrying claims for principal, project, session, and agent grant. Connector credentials are bound server-side and injected at runtime; they never enter the sandbox environment, the transcripts, or the model’s view.

- **Least privilege per session** — an agent sees only the connectors and secrets it was granted, nothing more.
- **Policy as code** — `connectors:` in the manifest carry per-action policies; matching an outbound message can require a human before it ever sends.
- **One scoped token** — granular permissions stop an agent from touching tools it shouldn’t, the way a mature platform scopes API access rather than handing out a god key.

A 100× more capable model does not get 100× more authority. It runs inside the same identity, the same scoped token, and the same policies it always did.

## Execution is isolated from the control plane

An intelligent agent should never execute directly inside the control plane. In Kortix, every session is its own isolated Linux sandbox on its own git branch — a disposable machine the agent owns, with filesystem, network, and process isolation. Thousands run in parallel on the same config without colliding, because none of them share state. Egress and credentials are controlled at the network boundary, and the sandbox assumes the agent-generated code is untrusted even when the model looks reliable.

Work reaches `main` one way: through an approved change request. The sandbox is where the agent thinks and acts; `main` is where the company lives, and the two are deliberately not the same place.

## Long-running work is durable and resumable

AGI-level work will not fit into a single HTTP request. An agent should be able to sleep for three months, wake because an event fired, reload its identity and state, and continue correctly. Kortix sessions are durable: stop a running session and it pauses in place with its compute metering closed; resume it and it picks up where it left off. Retryable failures auto-resume a turn with bounded backoff; the user keeps control through a kill switch.

Triggers declare their own session strategy — a fresh session each run, a reused loop session, or a pinned one — so a long-lived operator can carry context across invocations instead of restarting cold every time the clock ticks.

## Every consequential action is auditable and evaluable

Git history is the audit trail; the change request is the review gate. Every PR spins up a full ephemeral environment — a real backend and a wired frontend — so a change is tested end to end, not just linted. The important metric is not “the model scored 90%.” It is: what percentage of real tasks finish correctly, safely, autonomously, within budget? That is a reliability question, and the platform is built to answer it with actual preview runs, not vibes.

## Learning is gated, versioned, and reversible

An AGI-ready platform turns production experience into improvement — but never lets a model auto-edit its own behavior. In Kortix, a skill is a file: purpose, preconditions, steps, policies, examples, tests, version, and provenance. An agent can propose a new skill, but it ships through a controlled lifecycle with review, not by mutating itself in production. Memory is layered — working, episodic, semantic, procedural — and a trusted subsystem decides what is persisted, with deduplication, provenance, and expiration. Learning a fact, remembering a preference, and changing an agent’s behavior are different operations with different gates.

## Humans can inspect, interrupt, and terminate

Human-in-the-loop is a first-class runtime primitive, not a setting. Approval requests, escalation, plan editing, and emergency termination are all part of the loop. The interface shows what the agent intends to do, why it intends to do it, what it used to decide, what could go wrong, what it will cost, and whether the action is reversible — then asks for exactly the permission it needs. A stop button that actually stops is not a nice-to-have when the agent can spend money.

## Costs and resources are bounded

A capable system without budget control can create effectively unlimited spend. Kortix tracks token, compute, sandbox, and tool cost against per-run and per-objective budgets, with holds and reconciliation so a streamed completion is billed at the rate it actually used. Idle sandboxes are reaped — quiet machines are stopped, not billed forever. Fan-out into hundreds of subtasks stays a controlled, cost-bounded operation rather than an open tab.

## More capability, not more authority

That is the whole thesis in one line. A 100× model should make Kortix do 100× more work — it should not get 100× more access. Authority is capped by identity, policy, sandbox, and review, and none of those are controlled by the model. The capability jumps; the guardrails hold. That is what AGI-ready means in practice, and it is the difference between a platform that survives the next model and one that has to be rebuilt around it.

## Side by side

```compare
them: An LLM wrapped in tools
rows:
  - dimension: Where state lives
    them: In the context window
    kortix: Files in a git repo + layered memory
  - dimension: Who authorizes actions
    them: The model decides what it may do
    kortix: Policy engine + scoped connectors
  - dimension: Where execution happens
    them: In your control plane
    kortix: Isolated sandbox per session, per branch
  - dimension: Resumability
    them: Lost when the request ends
    kortix: Durable; stop, resume, wake on events
  - dimension: Review & rollback
    them: No diff, no rollback
    kortix: Every change a reviewed change request
  - dimension: Models
    them: Welded to one vendor
    kortix: Any model, your keys, self-hostable
  - dimension: Cost control
    them: Unbounded by default
    kortix: Per-run budgets + idle reaping
```

## When to pick which

```verdict
themLabel: the wrapper
them: you are shipping a single model’s output straight to production with no durable state, no permission boundary, and no review — and betting that a smarter model makes that safe.
kortix: you want the capability jump without the authority jump — agents that do 100× more work inside the same identity, policy, sandbox, and review you already control.
```

The companies that win the next decade of AI won’t be the ones with the best model. They’ll be the ones whose platform can take whatever model shows up next and put it to work safely. If that operating layer is what you’re missing, the [introduction](/blog/introducing-kortix) and the [company-as-a-repo thesis](/blog/ai-transformation-company-os) are the next reads.

```cta
title: Build for the jump, not the model.
body: Kortix is the open-source AI Management System — self-hostable, any model. Start one project free.
```
