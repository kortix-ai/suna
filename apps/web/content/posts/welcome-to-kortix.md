---
title: "Welcome to the Kortix blog: how we build and run an open-source agent system"
description: "The Kortix blog introduces the open-source system it covers and shares how teams build, run and review production AI agents."
date: "2026-09-11"
canonical: "https://kortix.com/blog/welcome-to-kortix"
author: "team"
tags: ["Product"]
updated: "2026-10-21"
slug: "/welcome-to-kortix"
---
Running AI agents that do real work is mostly a system problem. Kortix is open source, so a team can own the system. The Kortix blog is where we write down how we build and run it. That includes the decisions and the dead ends. If your team is putting agents into production, the writing here aims to save you some of that work.

## What the blog covers

The writing here is about the work that decides whether an agent is useful: making a workflow dependable, choosing a runtime and a model without locking the company in, and the product decisions behind an agent you would trust with a real task. The audience is the person who has to make those calls. That can be an engineer, a platform lead, or the first founder running agents at a small company. The writing assumes you can read a git diff and a config file. It leaves out the parts that only survive in a demo.

## The system behind the writing

The blog describes one system because that is the one we run. Kortix is the open-source AI Operating System. The agents, the skills they share, the memory they keep and the connectors they use are files in one git repository ([Kortix on GitHub](https://github.com/kortix-ai/suna)). A single repo makes the whole company searchable and every change a diff. You can read a proposed change, roll a bad one back, or copy the part that works into your own project.

How the work lands matters as much as how it runs. Each session gets its own isolated machine and its own branch. An agent can install, run and break things there. Nobody else's work is touched. The commits reach the default branch through a change request. A person reads it first ([product docs](https://kortix.com/docs)). You can run one session or many in parallel. The review step stays the same.

## What the writing gives you

The writing should leave you with something you can act on: a control to add, a signal to watch, a cheaper way to run the same workload, or a reason to avoid a choice someone else has already made. Claims that a reader might doubt, from a vendor's price to a model's limit, carry a link to the source, so you can check the number. The product reference lives on the product side, in the docs and in the open repository, where you can read the code.

## Where to start reading

Three earlier essays show the range. [How to build reliable AI agent workflows](/blog/how-to-build-reliable-ai-agent-workflows) maps each production failure mode to a concrete control and the signal that proves it works. [The OpenAI Agents API for teams](/blog/openai-agents-api-what-it-changes-for-teams) covers what the managed agent runtime changes and when to adopt it. [GPT-6 Astra for agent teams](/blog/gpt-6-astra-for-agent-teams) explains what the model changes for delegated work and where its limits still sit.

To put your own agents in a repo you own, start at [kortix.com](https://kortix.com). Build a project and start a session. Then let the first change request come to you.
