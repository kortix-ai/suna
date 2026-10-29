---
title: "Kortix vs Claude Cowork: Cowork went everywhere, stayed closed"
description: "Cowork became part of Claude in September 2026; Kortix stays open source, self-hostable, and built to run a company's agent work."
date: "2026-06-29"
canonical: "https://kortix.com/blog/kortix-vs-claude-cowork"
author: "marko"
tags: ["Comparisons", "Agents"]
updated: "2026-10-18"
slug: "/kortix-vs-claude-cowork"
coverLogos: [{"domain": "claude.ai", "name": "Claude Cowork"}]
cover: "/banner.png"
---
> Cowork is now one excellent agent inside Claude itself. Kortix gives that same working power to a whole company, governed and self-hostable.

Claude Cowork earned its reputation as a strong single-player agent. On September 16, 2026, Anthropic folded it into Claude itself: what it does now starts from any conversation. The rollout reaches Pro and Max plans first, moving gradually across web, desktop, and mobile. What changed is reach. The terms are the ones Cowork always had: closed source, Claude models only, no self-hosting. Kortix, an open-source AI Operating System, was built for the teams that need the opposite. The choice in front of a team is starker now: rent a feature, or own the system.

```logos
label: 'Compared here:'
items:
  - domain: anthropic.com
    name: Claude Cowork
```

## Cowork is now part of Claude

Anthropic's [release notes](https://support.claude.com/en/articles/12138966-release-notes) for September 16, 2026 carry the heading "Claude Cowork comes to every conversation." Chat and Cowork are one surface now: a quick question and a bigger job, like a report or a spreadsheet, happen in the same thread. Chats, Cowork tasks, projects, connectors, and skills carry over. Pro and Max plans see the new experience first. Enterprise administrators get at least 30 days' notice, and [once an account moves over there is no switching back](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude).

Two changes earlier in 2026 led into the merge. Since July 7, Cowork sessions have run remotely in the cloud. Work continues after the laptop closes, and [scheduled tasks run with no device online](https://support.claude.com/en/articles/12138966-release-notes). Since August 25, memory spans chat and Cowork in the cloud; Free, Pro, and Max plans get it by default, while Team and Enterprise organizations start with it off.

## The case for Cowork

- **It returns finished work.** Give it a goal and it searches, reads your files, and runs code. What comes back is [documents, spreadsheets, and presentations you can open and edit](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude).
- **A permission model that asks.** Claude [shows its plan and waits for your approval](https://claude.com/product/cowork) before anything significant, and deleting anything needs your approval. The merged experience adds a permission setting. Manual, the default, asks before each action. Auto keeps working under automated safety checks.
- **It works while you're away.** Tasks keep running in the cloud after the laptop closes, and [a scheduled task runs on any cadence, unattended](https://claude.com/product/cowork).
- **Extend it with skills, plugins, and connectors.** Plugins bundle your tools, knowledge, and workflows into one install; on Team and Enterprise plans, admins manage them for everyone.
- **Enterprise observability.** On Enterprise plans, Cowork activity [streams to your SIEM through OpenTelemetry](https://claude.com/product/cowork), with usage analytics and an Analytics API beside it.

## Where it stops being enough

- **Closed, and not hostable.** Cowork runs in Anthropic's cloud, or in your own Amazon Bedrock, Google Cloud, or Microsoft Foundry account. Either way it is Anthropic's software on Anthropic's terms; there is no version your team hosts.
- **Claude models only.** Anthropic's product pages document [no bring-your-own-model path](https://claude.com/product/cowork) for Cowork. Every task runs on a Claude model, at the rate your plan sets.
- **One usage pool.** Everything you do with Claude [counts toward your plan's usage limits](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude), and agentic tasks draw that pool down faster than chat does.
- **Configuration lives in Anthropic's product.** Skills, plugins, connectors, and memory are settings in Claude's apps and state in Anthropic's cloud. A company's way of working exists there, where nobody on the team can version it, diff it, or audit it.

For one person, that is a fair deal. Plans that include Cowork [start at $17 a month](https://claude.com/pricing) billed annually, or $20 month to month, checked October 2026. The terms start to bite the moment the tool has to serve an entire company instead of one desk.

## The other answer to those terms

Kortix was built on a different bet. An agent's behavior, its skills, the company's shared memory, and the rules for each connector are files in one git repository. Teach one agent something and every teammate and every other agent inherits it. The setup accumulates rather than starting over with each new hire. Every change has an author, a diff, and a reviewer, so a new way of working gets the same scrutiny a code change gets.

The repository is also the governance mechanism. An agent opens a change request, and a person decides what lands on `main`; by default agents hold no merge rights, though an admin can grant that one capability.

Nothing about how the platform works is hidden from the teams that run it. Open source. Read it, fork it, audit it. Scale comes out of the same files: thousands of agents in parallel on one config, each on its own cloud computer.

Where the data has to stay decides where the system runs. Run it on Kortix Cloud, in your VPC, or on your own on-prem network. Self-host is free.

## Who picks the model, and who pays

Cowork runs on Claude models, so the engine choice is made for you. Anthropic's [API list prices](https://claude.com/pricing) put Opus output at $20 per million tokens. The frontier Fable family runs $50, checked October 2026. A Cowork plan hides those numbers behind usage limits, and agentic work drains a limit fast.

Kortix runs on the opposite arrangement. Any model provider with your own keys. Or the ChatGPT plan you already pay for. Open-weight models put real numbers on the gap. [Z.ai's price page](https://docs.z.ai/guides/overview/pricing) lists GLM-5.2 output at $4.4 per million tokens. DeepSeek's [deepseek-flash](https://api-docs.deepseek.com/quick_start/pricing) prices 1M output tokens at $0.6 off-peak and $1.2 at peak, both checked October 2026. Send the routine volume to a cheap model and reserve frontier tokens for the steps that justify them.

> The same workload, [a fraction of the bill](/pricing), on computers your company owns.

## Row by row

```compare
them: Claude Cowork
rows:
  - dimension: Real, multi-step work
    them: Yes, from any Claude conversation
    kortix: Yes, each session gets a cloud computer
    lean: both
  - dimension: Open source
    them: No, closed source
    kortix: Yes, hosted or self-hosted
    lean: kortix
  - dimension: Where it runs
    them: Anthropic's cloud, or a Bedrock, Google Cloud, or Foundry account
    kortix: Kortix Cloud, a private VPC, or your own hardware
    lean: kortix
  - dimension: Runs while nobody watches
    them: Tasks run on any schedule, unattended
    kortix: Cron schedules and signed webhooks kick sessions off
    lean: both
  - dimension: Choose your models
    them: Claude models only
    kortix: Any provider, your own keys
    lean: kortix
  - dimension: Where agents, skills, and memory live
    them: Settings in Claude's apps
    kortix: Versioned files in your repository
    lean: kortix
  - dimension: Approval before big actions
    them: Shows its plan, waits for approval
    kortix: A person reviews and merges each change
    lean: both
  - dimension: How the work gets paid for
    them: Draws down your plan's usage limits
    kortix: Credits pay for computing, your keys pay for models
    lean: kortix
```

## Who each one is for

```verdict
themLabel: Claude Cowork
them: you want one polished assistant for yourself or a small team, and you accept Anthropic's models, Anthropic's terms, and one usage pool.
kortix: you want the same working power run as company infrastructure, with agents in parallel, any provider with your keys, and a setup that lives in your own repository.
```

One limit worth naming on our side: Kortix agents work on their own cloud computers. Cowork, on Pro and Max plans, can also take over your screen in a beta computer-use mode, checked October 2026. If your work lives in local files and desktop apps, that direct reach can decide the question by itself. Running both is a real pattern, too: a power user keeps Cowork for personal tasks while the company's agent fleet runs on Kortix, where people review what it does.

Two related posts, if you want to go deeper: [ChatGPT Work vs an open-source alternative your company can own](/blog/open-source-chatgpt-work-alternative) covers the other hosted option, and [Personal AI agents vs a company OS](/blog/personal-ai-agents-vs-company-os) draws the line between a personal assistant and a company system. When you are ready to try the platform itself, [Getting started with open-source Kortix](/blog/getting-started-with-kortix) takes three commands.

Put a fleet of agents to work under rules you set. Connect your tools, give one a real piece of work, and approve the change request it opens when the job is done. Trying it costs nothing, and so does self-hosting. [Try Kortix](https://kortix.com)
