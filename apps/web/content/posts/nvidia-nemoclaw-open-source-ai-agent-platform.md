---
title: "NVIDIA NemoClaw: the open-source AI agent platform, explained"
description: "NVIDIA NemoClaw is the open-source reference stack for running agents safely on NVIDIA hardware; Kortix is the open-source layer for the whole agent workforce."
date: "2026-09-27"
canonical: "https://kortix.com/blog/nvidia-nemoclaw-open-source-ai-agent-platform"
author: "team"
tags: ["Comparisons"]
updated: "2026-10-24"
slug: "/nvidia-nemoclaw-open-source-ai-agent-platform"
coverLogos: [{"domain": "nvidia.com", "name": "NVIDIA"}]
---
NVIDIA NemoClaw is the open-source reference stack NVIDIA ships for running supported agents safely on its own hardware. Kortix is the open-source AI Operating System for a whole agent workforce, on any infrastructure, with your keys. NemoClaw governs how an agent executes; Kortix governs how finished work lands. The choice turns on which layer your team actually needs.

## What NemoClaw is

NVIDIA NemoClaw is an open-source reference stack for running supported AI agents more safely inside NVIDIA OpenShell sandboxes ([GitHub](https://github.com/NVIDIA/NemoClaw)). It ships as a collection of blueprints that bundle three pieces of the NVIDIA Agent Toolkit: Nemotron and other frontier models, NeMo for specialization and optimization, and OpenShell for runtime policy controls. The blueprints move a team from prototype to governed deployment with runtime controls, model routing, skill execution, and observability ([overview](https://www.nvidia.com/en-us/ai/nemoclaw/)).

The stack supports three agents: OpenClaw as the default, Hermes, and LangChain Deep Agents Code ([GitHub](https://github.com/NVIDIA/NemoClaw)). OpenClaw, the default agent, was first called Clawdbot, then Moltbot, before OpenAI acquired the project ([WIRED](https://www.wired.com/story/nvidia-planning-ai-agent-platform-launch-open-source/)).

NemoClaw ships under Apache 2.0, and NVIDIA labels it an alpha project. It is a stack you run and extend yourself. There is no managed offering and no support SLA.

## What NemoClaw does best

NemoClaw gives a single agent a governed place to run, which is what teams adopting agents on local hardware need most.

- **Sandboxed execution.** OpenShell is the security boundary and enforces what the agent can access: files, networks, credentials, and tools.
- **Policy controls.** Network rules, an operator approval flow, egress control, and sandbox hardening keep sensitive actions under review.
- **Managed inference.** You choose local Nemotron models, cloud frontier models, or a router that blends both under privacy controls.
- **Lifecycle operations.** The NemoClaw CLI covers guided onboarding, snapshots, and agent aliases for each supported harness.
- **Hardware fit.** NVIDIA provides local, 24/7 compute on RTX Spark laptops, GeForce RTX PCs and laptops, RTX PRO workstations, and DGX Station or DGX Spark ([overview](https://www.nvidia.com/en-us/ai/nemoclaw/)).

NVIDIA also continues to contribute to OpenClaw, the project its default agent comes from ([overview](https://www.nvidia.com/en-us/ai/nemoclaw/)). For a team already using NVIDIA hardware, that is one supported path from a laptop or workstation to an always-on agent.

## How NemoClaw runs an agent

NemoClaw installs with one shell command: `curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash`. That command defaults to OpenClaw. Set the `NEMOCLAW_AGENT` variable to `hermes` or `langchain-deepagents-code` to run Hermes or LangChain Deep Agents Code instead ([overview](https://www.nvidia.com/en-us/ai/nemoclaw/)).

Whichever agent you choose runs inside an OpenShell sandbox. OpenShell is the runtime that enforces what the agent can access, and it applies network policy and managed inference under operator approval. The express install path takes the recommended preset and installs OpenClaw by default; choosing otherwise lets you pick the agent, a sandbox name, an inference provider, and a model interactively. NemoClaw wraps that runtime with the CLI and its agent-specific aliases ([GitHub](https://github.com/NVIDIA/NemoClaw)).

NemoClaw is hardware-centric. NVIDIA lists local compute on RTX Spark laptops, GeForce RTX PCs and laptops, RTX PRO workstations, and DGX Station or DGX Spark. The repository requires a supported DGX or Windows Subsystem for Linux host. Alpha status matters here: maintainers review issues, discussions, and pull requests on a best-effort basis, with no guaranteed response timelines ([overview](https://www.nvidia.com/en-us/ai/nemoclaw/), [GitHub](https://github.com/NVIDIA/NemoClaw)).

## Where NemoClaw stops and Kortix starts

NemoClaw governs how an agent executes. Kortix governs how finished work lands. Kortix keeps your agents, skills, company memory, and configuration in one git repo you own. One sandbox per session, each with its own isolated machine and branch. When the work is ready, the agent opens a change request, and the change reaches the default branch once a person approves it ([Kortix docs](https://kortix.com/docs)).

The guardrails sit at different points. OpenShell constrains the agent while it runs. Kortix constrains what lands: merge is default-deny for agents, and an admin can grant the merge capability to an agent that needs it. That difference matters most when many agents work at once and every change needs an owner.

Kortix is model-agnostic. You run any model with your own keys, in the cloud or on your own hardware. Kortix is open source: self-host, read and modify the code. Sessions start from the web app, Slack or Microsoft Teams, the CLI, or the API.

## Side by side

Both projects are open source and both run the agent inside a sandbox. The differences that decide a pick are where it runs and how its work gets approved.

| Dimension | Kortix | NVIDIA NemoClaw |
|---|---|---|
| Open source | Yes | Yes, Apache 2.0 |
| Where it runs | Any cloud, VPC, on-prem, or self-hosted | Supported NVIDIA RTX, RTX PRO, or DGX hardware |
| Choose your models | Any model, your keys | Nemotron and other models under policy |
| How work lands | A change request a person approves | Agent runs in an OpenShell sandbox |
| Configuration | Git files you own and can diff | Blueprints plus the NemoClaw CLI |
| Maturity | Production platform; managed cloud and enterprise support | Alpha; best-effort maintainer review |
| Cost | Free to start, free to self-host | Free software; you bring NVIDIA hardware |
| Best for | Managing many agents across infrastructure | Running one agent on NVIDIA hardware |

## When to pick which

Pick NemoClaw if your team already runs supported NVIDIA hardware and wants an always-on agent under policy controls. It gives that agent a sandboxed, governed place to execute, with OpenShell enforcing its file, network, credential, and tool access, and a CLI to manage its lifecycle. The trade is real: NemoClaw is alpha software tied to NVIDIA hosts, and it governs execution. Landing the finished work is a separate layer ([GitHub](https://github.com/NVIDIA/NemoClaw)).

Pick Kortix when you want many agents across any infrastructure with a person approving what lands. That model scales past a single always-on assistant: every agent draws on the same company memory, and one review gate covers the fleet. Nothing merges itself: session work reaches the default branch through a change request a person approves, unless an admin granted the merge capability. Any model, your keys, self-hosted or managed cloud ([Kortix docs](https://kortix.com/docs)).

For a wider view of the category, read the guide to [open-source AI agent platforms](/blog/open-source-ai-agent-platform) and the comparison of [Kortix and Claude Cowork](/blog/kortix-vs-claude-cowork).

Get started with [open-source Kortix](https://kortix.com): start free, then self-host on your own infrastructure.
