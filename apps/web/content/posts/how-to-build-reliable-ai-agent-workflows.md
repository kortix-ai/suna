---
title: "How to build reliable AI agent workflows with open-source Kortix"
description: "Map AI agent workflow failure modes to concrete controls, with a reference implementation on open-source Kortix."
date: "2026-09-11"
canonical: "https://kortix.com/blog/how-to-build-reliable-ai-agent-workflows"
author: "team"
tags: ["Field notes"]
updated: "2026-10-02"
slug: "/how-to-build-reliable-ai-agent-workflows"
---
Reliable AI agent workflows fail in ways a generic retry does not fix: a tool reports success while returning an error payload, an upstream schema drifts, or a loop has no exit. Treat reliability as engineering around the model. Name each failure mode, attach one control, and instrument the signal that proves the control holds. Kortix is the open-source platform that supplies those primitives, from a sandbox per session to a review gate on every change.

## Why agent workflows fail in production

Agent workflow failures cluster into a small set of recurring modes. Each mode needs a different control and a different signal, so a generic "add retries" fix covers one row and leaves the rest.

| Failure mode | What it looks like | Control | Signal |
|---|---|---|---|
| Silent tool failure | A tool returns success with an error payload, an empty result or a stale value | Validate the result content, not the transport status | Tool-error and empty-result rate |
| Schema drift | An upstream API renames or retypes a field while the agent parses the old shape | Validate typed input and output at every step boundary | Schema-validation failures per step |
| Non-determinism | The same input produces different plans or outputs across runs | Pin the model and version, and run a fixed eval set | Eval pass-rate variance |
| Context rot | The model misses a fact as the context fills with distractors | Retrieve only relevant context, compress it, restate the task | Task-success rate against context size |
| Compounding errors | One wrong step becomes the input to the next | Programmatic gates between steps and a bounded verifier pass | Gate-failure and rework-loop rate |
| Runaway loops | The agent iterates because no exit condition ever evaluates true | Cap iterations and set explicit stopping conditions and budgets | Timeouts and cost per task |
| Unguarded side effects | The agent sends, deletes or charges without review | Human approval before irreversible actions, and least-privilege credentials | Unapproved actions, which should be zero |
| Duplicate side effects | A retried call creates a second resource | Idempotency keys, timeouts, capped backoff with jitter, a circuit breaker | Duplicate-action and circuit-open counts |

Context rot shows why the control has to match the mode: Chroma's evaluation found model performance degrading as input length grows, with topically related distractors reducing it further ([Chroma](https://research.trychroma.com/context-rot)). The structural choice comes before any of these controls, though: how much of the flow the model is allowed to decide.

## Choose the simplest structure that fits

Anthropic separates a workflow from an agent ([Anthropic](https://www.anthropic.com/engineering/building-effective-agents)). A workflow orchestrates models and tools through predefined code paths. An agent lets the model direct its own process and tool use. Both are agentic systems, and they carry different failure profiles: a workflow is predictable and rigid, while an agent is flexible and exposed to compounding errors.

Google Cloud reaches the same conclusion from the design side: start with a single agent so you can refine the core logic, prompt and tool definitions before adding more ([Google Cloud](https://docs.cloud.google.com/architecture/choose-design-pattern-agentic-ai-system)). A single agent's performance drops as it takes on more tools and more complex tasks, which shows up as latency, wrong tool selection or unfinished work. Anthropic's advice is to find the simplest solution possible and add complexity only when it earns its place.

## Bound the loop and make retries safe

The loop is where an agent's flexibility turns expensive. Google Cloud describes a loop pattern that repeats subagents until a termination condition is met, and warns that its "primary trade-off is the risk of an infinite loop" when that condition is not correctly defined ([Google Cloud](https://docs.cloud.google.com/architecture/choose-design-pattern-agentic-ai-system)). Set an exit condition the workflow can actually evaluate, plus a maximum number of iterations and a budget for time and tokens. Anthropic lists stopping conditions such as a maximum number of iterations as part of the design ([Anthropic](https://www.anthropic.com/engineering/building-effective-agents)).

Retries help with transient faults only when the operation is idempotent. AWS's guidance is that the effect of a retried call should happen once even when the call is made multiple times ([AWS](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)). For timing, capped exponential backoff with jitter spreads retries so clients do not retry in synchronized bursts ([AWS](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)). A timeout bounds each attempt, and a circuit breaker stops calling a service after failures cross a threshold so it can recover ([Azure](https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker)). For a long run, a durable execution system runs the workflow to completion and, after a crash, resumes at the point where it stopped ([Temporal](https://docs.temporal.io/evaluate/understanding-temporal)).

## Validate every boundary and gate every side effect

Every boundary between steps is a place where a wrong shape enters the workflow. Define the expected input and output of each step and validate it against a schema before the next step consumes the result. JSON Schema is a common way to express that shape, and a mismatch fails fast instead of flowing downstream ([JSON Schema](https://json-schema.org/understanding-json-schema)).

Anthropic warns that agents carry "the potential for compounding errors", so a wrong step should not quietly become the input to the next ([Anthropic](https://www.anthropic.com/engineering/building-effective-agents)). Put programmatic checks between steps and a bounded verifier pass with explicit pass criteria. Google Cloud's review-and-critique pattern has a critic evaluate output against predefined criteria, and Anthropic's evaluator-optimizer runs a generator and a critic in a loop ([Google Cloud](https://docs.cloud.google.com/architecture/choose-design-pattern-agentic-ai-system), [Anthropic](https://www.anthropic.com/engineering/building-effective-agents)).

Some actions should never run unattended. Google Cloud asks whether a task involves high-stakes decisions, safety-critical operations or subjective approvals that need human judgment ([Google Cloud](https://docs.cloud.google.com/architecture/choose-design-pattern-agentic-ai-system)), and Anthropic notes that agents can pause for human feedback at checkpoints or blockers ([Anthropic](https://www.anthropic.com/engineering/building-effective-agents)). Gate irreversible actions behind approval, and give the agent only the credentials it needs.

## Track the signals that prove a control holds

Observability has to cover both the deterministic and the probabilistic parts of a workflow. The OpenTelemetry GenAI semantic conventions define spans, metrics and events for GenAI clients and MCP, which gives traces a shared vocabulary instead of a one-off log format ([OpenTelemetry](https://github.com/open-telemetry/semantic-conventions-genai)).

Read those signals per step. Emit one span for each step with its inputs, outputs, latency and errors. Track the tool-error and empty-result rate for each tool, schema-validation failures, task-success and rework-loop rates, and cost per task. Hold a fixed eval set of representative tasks and run it before any change to a prompt, a tool or a model; Anthropic recommends comprehensive evaluation and sandboxed testing with guardrails ([Anthropic](https://www.anthropic.com/engineering/building-effective-agents)).

## Reliable workflows on open-source Kortix

Kortix is the open-source AI Management System: agents, shared skills, company memory and connectors live in one git repo you own. A session runs an agent in an isolated sandbox on its own branch, and the agent opens a change request a human reviews and merges ([Kortix docs](https://kortix.com/docs)). Per-agent grants scope connectors, secrets and skills, connector credentials are brokered server-side so raw keys never enter the machine, and a full audit trail records what ran ([Kortix on GitHub](https://github.com/kortix-ai/suna)). Kortix is open source (Elastic License 2.0): self-host, read and modify the code.

```yaml
# kortix.yaml: governance only; agent behavior lives in .kortix/opencode/agents/
kortix_version: 2
default_agent: workflow-runner
agents:
  workflow-runner:
    connectors: [github]
    secrets: []
    skills: [reliability-checks]
triggers:
  - slug: nightly-run
    type: cron
    agent: workflow-runner
    prompt: |
      Validate every tool result against its schema, stop after five
      iterations, and open a change request instead of writing to main.
```

The platform supplies the controls that are expensive to build twice: isolation per session, a review gate before work lands, scoped credentials and an audit trail. Self-hosting runs on a laptop, a VPS, your VPC or on-prem ([Kortix on GitHub](https://github.com/kortix-ai/suna)). You still define the schemas, exit conditions, budgets and eval set for each workflow.

If tool access is the part you are hardening, [how to give AI agents tool access safely](/blog/secure-ai-agent-tool-access) covers scoped connectors and approval policies. [Open-source AI agent platforms](/blog/open-source-ai-agent-platform) compares the options on licence, deployment and model choice, and [getting started with Kortix](/blog/getting-started-with-kortix) walks through the first session.

Start with one workflow. Name its failure modes, attach a control to each, and measure the signal that proves the control holds. [Get started with open-source Kortix](https://kortix.com), or [read the docs](https://kortix.com/docs) to run the reference shape yourself.
