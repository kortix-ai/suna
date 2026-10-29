---
title: "Kortix vs LangGraph: open-source agents need a system you own"
description: "Kortix is the open-source system a company owns end to end; LangGraph is the low-level framework for stateful agents in code."
date: "2026-10-13"
canonical: "https://kortix.com/blog/kortix-vs-langgraph"
author: "team"
tags: ["Comparisons"]
updated: "2026-10-22"
slug: "/kortix-vs-langgraph"
---
LangGraph is the low-level orchestration framework a Python team reaches for when it wants an agent's control flow as code, and Kortix is the open-source AI Operating System a company runs that logic on once the agents leave a single application. Do you need a library for describing how an agent reasons, or a system for running, gating and reviewing the work a company's agents do? LangGraph answers the first well, and it is the second that decides what a company ends up owning.

## What LangGraph gives you

LangGraph is a low-level orchestration framework for building, managing and deploying long-running, stateful agents. LangChain Inc builds it, and the library is [released under the MIT license](https://github.com/langchain-ai/langgraph). Its own [documentation](https://docs.langchain.com/oss/python/langgraph/overview) calls it focused entirely on orchestration. It gives fine-grained control to mix deterministic, hand-coded steps and model-driven steps in one graph.

The capabilities it documents are the ones that keep an agent alive in production. Durable execution resumes a run where it stopped. Interrupts let a person step in and change the state. Working memory holds one run, long-term memory carries across runs, and LangSmith traces, evaluates and deploys.

None of that is small. A team that writes its agent as a graph knows what the code does, can test it in its own suite, and can change the flow without asking a vendor. If your agents live inside a product you already build and host, this is the right shape for them.

## The system around the graph

On Kortix the repository is the unit of work. An agent's definition, the instructions it follows, the memory it accumulates and the tools it may call all sit in that repo as plain text.

A Kortix project is a git repo with `kortix.yaml` at its root. Behaviour lives in markdown agents, and the manifest states what each agent may reach:

```yaml
kortix_version: 2
default_agent: analyst
agents:
  analyst:
    file: agents/analyst.md
    connectors: [kortix_slack]
    skills: all
```

Two files, both readable by a person and both diffable in a change request. A reviewer who asks which tools an agent may call opens `kortix.yaml` and reads the answer. The same repo holds the memory the agents accumulate, the connectors, the triggers and the machine image. A change to any of them arrives as a diff someone can approve or reject.

Each session boots its own isolated cloud computer with the repo already cloned and works on its own branch. What the agent changes comes back as a change request, and nothing merges itself: a person reads the diff and approves it, unless an admin granted the merge capability.

LangGraph gives you a program to run. Kortix gives you the repository, the machines and the review step the program runs inside.

## Where LangGraph is the right call

- **The agent is part of a product.** When agents are a feature inside software you already build, ship and host, a library keeps them next to the rest of the application and inside the same release process.
- **You want the control flow in code you review.** LangGraph does not abstract your prompts or your architecture. The behaviour stays exactly what the code says, which is what a team with a custom control flow wants.
- **Your platform is Python.** The library installs as a Python package, so it fits a team that already runs Python services and does not want a new hosting model to learn.
- **Tracing and evaluation belong in your application.** LangSmith traces execution paths and scores outputs, which matters when agents are judged against application-level tests.

## What a framework leaves on your desk

A framework answers how an agent reasons. It does not answer who owns the memory the agent draws on, which tools it may touch, or how its work gets reviewed before it counts. Those questions arrive once more than one person and more than one agent share the same context, and they arrive in that order.

Shared state comes first. Several agents need what the company decided last quarter, and several people need to see what each one learned. A store inside one application stops being the right home for that. Reach into real tools comes next. Wiring a CRM, a billing system and a code host into agent logic is application plumbing. It stops being plumbing once the rules about which agent may write to billing have to live somewhere a security reviewer can read. The review gate follows, because work that changes something the company depends on should land the way code lands: as a diff a person approves.

Kortix puts those pieces in the repo. Three commands take a directory from nothing to a running project:

```bash
kortix init
kortix ship
kortix sessions new --prompt "Summarize this week's commits and open a change request"
```

`kortix init` turns the directory into a project with a manifest, a default agent and the repo layout. `kortix ship` validates the manifest, asks for any secret the project declares and is missing, then pushes the project up and runs it. `kortix sessions new` starts a session on a fresh machine, where the agent reads the repo, does the work on its own branch, and opens the change request with the diff attached.

## What the plan pays for

Nobody buys a seat on Kortix. Members are unlimited and free, the account shares one credit wallet, and unused monthly credits roll over one month. The free plan is $0 with 500 credits a month, every feature and one project, running on your own provider keys or the ChatGPT subscription you already pay for.

Paid is the Credits plan, where you choose the monthly amount. 5,000 credits costs $50, and every tier buys credits at 100 credits per dollar. Four things draw on that balance. Kortix-managed model calls cost the provider's base price plus a 5.5% platform fee. Calls on your own provider key are free for the first $1,000 of usage a month, then 5% of each request. Sandbox compute runs at about 11 credits an hour for the default 2 vCPU, 4 GB and 20 GB machine. Web search, image search and web scraping requests that go through Kortix are metered per call. The [pricing page](https://kortix.com/pricing) shows the arithmetic and the [credits page](https://kortix.com/docs/credits) lists each line.

The software is the part you keep. Self-hosting is free: clone the repo, run it on your own machines, and there are no managed models and no credits to buy. The same manifest runs on Kortix Cloud, inside your VPC, or on hardware you host yourself.

## Side by side

| | Kortix | LangGraph |
| --- | --- | --- |
| Open source | Yes | Yes, MIT license |
| What it is | A company's agents, memory and connectors in one repo | A low-level framework for stateful agents in your code |
| Where agents run | An isolated cloud computer per session | Wherever you deploy the process |
| Memory | Company memory as files in the repo | Short and long-term memory in your own store |
| Review before it lands | A change request a person approves | Interrupts you build into the graph |
| Self-host | Cloud, VPC or on-prem; self-host is free | In your own infrastructure |
| Cost shape | 500 free credits a month, then paid credits, no seats | The library is free; hosting is yours to run and pay for |

## Which to pick

Pick LangGraph when you are building agent logic inside an application you already run. You want the graph, the state and the observability to be code your team controls. That is a large, ordinary case, and the framework earns its place in it.

Pick Kortix when the agents stop being one application's feature and become how the company works. The signals are concrete. Several people and several agents draw on one memory. Agents act in tools where permissions and an audit trail have to hold up. The work has to pass a review gate before it counts. At that point the graph is the smaller half of the problem, and the system around it is what you want to own.

[Kortix on GitHub](https://github.com/kortix-ai/suna) is where to read, fork and audit that system. Create a project at [Kortix](https://kortix.com) and run a first session, or self-host it for free.
