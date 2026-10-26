---
title: "What the OpenAI Agents API changes for teams on an open-source platform"
description: "The OpenAI Agents API is in public beta, and it changes who runs the harness. What teams gain, what stays the same, and where open-source Kortix fits."
date: "2026-09-12"
canonical: "https://kortix.com/blog/openai-agents-api-what-it-changes-for-teams"
author: "team"
tags: ["Field notes"]
updated: "2026-10-02"
slug: "/openai-agents-api-what-it-changes-for-teams"
coverLogos: [{"domain": "openai.com", "name": "OpenAI"}]
---
The OpenAI Agents API changes who runs the loop. OpenAI now hosts and maintains the Codex harness that coordinates model calls, tools, and context ([OpenAI, 2026-09-10](https://openai.com/index/introducing-the-agents-api)). The useful question for a team is what that removes from the backlog, what stays exactly where it is, and which workloads it cannot take yet. Harness maintenance and some orchestration work come off your plate, the Responses API and Agents SDK stay in place, and teams that need European data residency or Zero Data Retention should hold off.

## What OpenAI shipped

OpenAI introduced the Agents API in public beta on 2026-09-10, and it runs the Codex harness for you ([OpenAI, 2026-09-10](https://openai.com/index/introducing-the-agents-api)). A developer creates an agent in a single API call by specifying the task, model, tools, and environment, while OpenAI hosts and maintains the harness ([OpenAI, 2026-09-10](https://openai.com/index/introducing-the-agents-api)). The API is powered by the open-source Codex harness, whose code is public, so the machinery is inspectable even though OpenAI operates it ([Codex on GitHub](https://github.com/openai/codex)). OpenAI documents the Agents API alongside the Responses API and the Agents SDK, and all three remain available ([OpenAI docs, accessed 2026-10-02](https://developers.openai.com/api/docs/guides/agents)).

## The harness stops being your maintenance job

The heaviest change is ownership. With the Agents API, OpenAI runs and maintains the Codex harness, so your team stops writing and patching the layer that sequences model calls, tool calls, and context ([OpenAI, 2026-09-10](https://openai.com/index/introducing-the-agents-api)). Compute stays your choice: an OpenAI-managed sandbox, your own infrastructure, or a partner sandbox. OpenAI names Blaxel, Cloudflare, Daytona, DigitalOcean, E2B, Modal, Oracle, Runloop, and Vercel as first-class sandbox partners ([OpenAI, 2026-09-10](https://openai.com/index/introducing-the-agents-api)). Those shifts remove recurring work: the harness on your backlog and the sandbox plumbing you maintain for each environment ([OpenAI docs, accessed 2026-10-02](https://developers.openai.com/api/docs/guides/agents)). The trade is direct control of the loop. You give it up in exchange for not running it, and OpenAI's comparison puts the Agents SDK as the option that keeps deployment, storage, approvals, and runtime integration inside your application ([OpenAI docs, accessed 2026-10-02](https://developers.openai.com/api/docs/guides/agents)).

## Parallel subagents, compaction, and tool search

Three capabilities move work out of your codebase. Multi-agent support breaks a task into independent pieces and delegates them to parallel subagents, each with its own context, while the main agent combines the results ([OpenAI, 2026-09-10](https://openai.com/index/introducing-the-agents-api)). Automatic context compaction summarizes earlier context as a session approaches its limit, so a workflow can span multiple context windows without your own compaction logic ([OpenAI, 2026-09-10](https://openai.com/index/introducing-the-agents-api)). Tool search loads relevant tool definitions as needed, which reduces token usage while preserving the model cache, and programmatic tool calling runs calls in parallel, chains operations, and filters results in code ([OpenAI, 2026-09-10](https://openai.com/index/introducing-the-agents-api)). Teams that built orchestration, summarization, or tool routing can drop those pieces from the plan when the workload fits the managed model.

## What does not change, and the limit a summary misses

OpenAI released the Responses API and the Agents SDK on 2025-03-11 as building blocks for agents, and neither is migrated or deprecated by this launch ([OpenAI, 2025-03-11](https://openai.com/index/new-tools-for-building-agents)). The Responses API combined the simplicity of the Chat Completions API with the tool use capabilities of the Assistants API, and the Agents SDK orchestrates single-agent and multi-agent workflows ([OpenAI, 2025-03-11](https://openai.com/index/new-tools-for-building-agents)). Pricing stays familiar: there is no additional fee for the Agents API, and you pay for the tokens and tools your agents use, with OpenAI-hosted sandboxes billed at standard container rates ([OpenAI, 2026-09-10](https://openai.com/index/introducing-the-agents-api), [OpenAI docs, accessed 2026-10-02](https://developers.openai.com/api/docs/guides/agents-api/overview)). The API is a public beta, and OpenAI says it will iterate quickly toward general availability, so interfaces can move ([OpenAI, 2026-09-10](https://openai.com/index/introducing-the-agents-api)).

Data governance is the operational constraint that decides adoption here. The Agents API supports data residency only in the United States and does not support Zero Data Retention, and choosing a self-hosted sandbox does not make it ZDR-eligible ([OpenAI docs, accessed 2026-10-02](https://developers.openai.com/api/docs/guides/agents-api/overview)). For a team with European residency requirements or a ZDR obligation, that is a blocker until OpenAI changes it, however attractive the managed harness looks.

## How to choose between the three runtimes

OpenAI's own comparison is the clearest way to pick a layer ([OpenAI docs, accessed 2026-10-02](https://developers.openai.com/api/docs/guides/agents)). The Agents API suits long-running tasks where OpenAI manages the agent and saves its progress. The Agents SDK suits custom tools and workflows that run inside your application. The Responses API suits calling models directly or building an agent from scratch ([OpenAI docs, accessed 2026-10-02](https://developers.openai.com/api/docs/guides/agents)).

| Dimension | Agents API | Agents SDK | Responses API |
|---|---|---|---|
| Use for | Long-running tasks, OpenAI manages the agent | Custom tools and workflows in your application | Calling models directly or from scratch |
| Where the agent runs | OpenAI-managed Codex harness | The SDK runs in your application | Your application, with optional hosted orchestration |
| Integration effort | Low | Medium | High |
| State between tasks | Saved session configuration, turns, and items | Your storage and SDK sessions | Manual history or Conversations |
| Tool execution | Service tools, function handlers, optional sandbox | Tools you configure in the application | Hosted tools and application-run tools |
| Execution environment | OpenAI sandbox, self-hosted sandbox, or none | Your runtime and sandbox providers | Your own execution environment |

Match the runtime to where the loop lives. Choose the Agents API when the work is long-running and you accept OpenAI running the loop. Choose the Agents SDK when orchestration has to stay in your process and you want control of deployment, storage, and approvals. Stay on the Responses API when the integration is narrow and does not need an agent loop ([OpenAI docs, accessed 2026-10-02](https://developers.openai.com/api/docs/guides/agents)).

## Where Kortix fits

Kortix is the open-source AI Management System: your agents, their skills, company memory, and every connector in one git repo you own, with any model and your own keys, self-hosted or on managed cloud ([kortix.com](https://kortix.com)). That places Kortix at a different layer from the Agents API. The Agents API is a managed runtime where OpenAI operates the harness; Kortix is a self-hostable platform for running and governing a team's agents across sessions. Each Kortix session runs on its own isolated sandbox and branch, and finished work lands as a change request a human reviews and merges ([Kortix docs](https://kortix.com/docs)). For a team weighing a hosted harness against infrastructure control, the two can be complementary, and the engineering work of making long-running workflows reliable applies either way ([how to build reliable AI agent workflows](/blog/how-to-build-reliable-ai-agent-workflows)). The project is open source, and the code is public ([Kortix on GitHub](https://github.com/kortix-ai/suna)).

If the runtime decision is still open, [how to build reliable AI agent workflows](/blog/how-to-build-reliable-ai-agent-workflows) maps production failure modes to concrete controls, and [what Kortix actually is](/blog/open-source-ai-management-system) explains the platform and the case for keeping the stack in a repo you control.

Start on your own machine or on managed cloud: [Get started with open-source Kortix](https://kortix.com).
