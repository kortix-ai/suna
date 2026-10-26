---
title: "Perplexity Personal Computer is a purchase; Kortix is an open-source repo"
description: "Perplexity Personal Computer comes four ways, each keeping the setup and work record in its app. Open-source Kortix keeps both in a git repo the company owns."
date: "2026-10-20"
canonical: "https://kortix.com/blog/kortix-vs-perplexity-personal-computer"
author: "team"
tags: ["Comparisons"]
updated: "2026-10-21"
slug: "/kortix-vs-perplexity-personal-computer"
---
Perplexity Personal Computer is the shortest path from a download to an agent working on your own machine; Kortix is the open-source AI Operating System a company can keep. Download the app, sign in, point it at a folder. The same product now arrives four ways: a cloud subscription, a desktop app, a local build for a supported GPU box, and a Mac mini that stays switched on. Whichever route you take, the setup and the record of the work stay inside Perplexity's product.

## One name, four purchases

Perplexity Computer began as a hosted worker. Start with an outcome. It splits the work into subtasks, runs subagents in parallel, and hands each task an isolated environment with a real filesystem and a browser ([Perplexity's launch post](https://www.perplexity.ai/hub/blog/introducing-perplexity-computer)). Personal Computer put that agent inside the desktop app, where it reaches local folders and native apps. Portable Computer moved the model, the harness, the orchestrator and the scheduler onto the device. The Mac mini is the always-on host Perplexity recommends for the desktop app.

Four purchase routes, as they stand in October 2026:

- **A cloud seat.** Computer comes with Pro, Max and Enterprise plans, and runs on desktop, mobile, Slack and Microsoft 365. Tasks are billed in credits. No server to keep.
- **Personal Computer on your own machine.** macOS 15 Sequoia or later, or Windows 10 and 11. On a Mac the app asks for Accessibility, Screen and System Audio Recording, and Full Disk Access, so the agent can click, see and read your files ([setup guide](https://www.perplexity.ai/personal-computer-setup)). Steps that run in the cloud spend credits.
- **Portable Computer on a GPU you bought.** An NVIDIA GeForce RTX or RTX PRO card with 24 GB of VRAM, an AMD Ryzen AI Max system on Windows, or an NVIDIA DGX Spark. Local work does not use credits, and the build asks before anything leaves the device ([Portable on Windows](https://www.perplexity.ai/hub/blog/portable-computer-for-windows-is-here)).
- **A Mac mini left running.** Tasks start from an iPhone and finish at the desk. Sessions on the mini are secured with 2FA ([help center](https://www.perplexity.ai/help-center/en/articles/14659663-what-is-personal-computer)).

The Windows build has one gap. As of October 2026, installed-app control is not yet available on Windows. The app still works on local files, Office 365, connected apps and the web. Driving Mail, Notes or Slack by itself is still a Mac capability.

## What each route leaves with you

You keep the hardware. A Mac mini, a workstation with a 24 GB card, the laptop you already own: no vendor can take those back.

The setup is a different matter. Folders are connected inside the app, and local inference is switched on per account. On Windows an administrator decides whether local inference is allowed at all. Only one local model runs at a time on Windows, Linux and DGX Spark. Credits are personal to the account and cannot be transferred or assigned. When the balance reaches zero, running tasks pause until you top up or the month resets ([how credits work](https://www.perplexity.ai/help-center/en/articles/13838041-how-credits-work-on-perplexity)).

For one person at one desk that is a fair trade. A team has a harder question: where the configuration lives, and who can read it. In all four routes it lives in an app, behind a login, in a format Perplexity controls.

## Four routes, one ownership test

| Measure | Kortix | Perplexity Personal Computer |
|---|---|---|
| Open source | Yes, read it, fork it, audit it | No |
| Hardware needed | None for Kortix Cloud; a machine to self-host | A Mac, a Windows PC, or a Mac mini |
| Time to a working agent | A repo, your keys, a deployment | Install the app and sign in |
| Where configuration lives | One git repo you own | Inside the Perplexity app |
| Where the work is recorded | Session branches in your repo | Tasks in a Perplexity account |
| Models | Any provider with your own keys | A roster Perplexity selects |
| Stop control | Approval gates and change requests you set | Per-action approval and a kill switch in the app |

One row goes to Perplexity: signing in is faster than a repo, keys and a deployment.

Perplexity's plans are $17 a month for Pro and $167 a month for Max, billed annually, as of October 2026 ([Perplexity pricing](https://www.perplexity.ai/hub/pricing)). A paid Consumer Pro plan gets a weekly amount of Computer usage before credits are touched. Max and Enterprise have no weekly allowance and draw on monthly credits, 10,000 a month on Max ([how credits work](https://www.perplexity.ai/help-center/en/articles/13838041-how-credits-work-on-perplexity)). On Kortix, self-hosting costs nothing and paid credits start at $50 a month.

## What the bundle gives up

**Continuity.** The always-on route is one machine in one room. Switch it off and the agent is off. There is no second copy of its setup waiting elsewhere.

**Portability.** Perplexity's documentation covers moving a task between a phone and a computer. It does not describe moving a Personal Computer setup to another agent runtime, as of October 2026. Skills, connector grants and folder permissions would be rebuilt by hand.

**A switch your security team can read.** Sensitive actions ask for approval, and a kill switch stops the work ([announcement](https://www.perplexity.ai/hub/blog/everything-is-computer)). Those controls are real, and they run inside software your reviewers cannot open. They can test the behavior. They cannot read the code behind it.

**The work record.** A task, its output and what it cost belong to the account that ran it. Task history is not a file your team can grep, branch, or hand to an auditor in a format you chose.

**The bill.** Credits make cost predictable per task and no further. A Max account carries a monthly spending cap of $200 by default, adjustable up to $5,000 ([credits](https://www.perplexity.ai/help-center/en/articles/13838041-how-credits-work-on-perplexity)). A dashboard build runs 2,400 to 9,800 credits, and an app build 15,000 or more. The cap is the number to watch.

## What owning the system looks like

A Kortix project is a git repository. Open source. Read it, fork it, audit it. The manifest is short enough to read in a review:

```yaml
kortix_version: 2
default_agent: kortix
agents:
  kortix:
    file: agents/kortix.md
    connectors: all
    skills: all
    workspace: { project_repository: true }
```

Two keys carry most of the meaning. `default_agent` names the agent a session boots when nothing else is specified. `file` points at the markdown file that holds its behavior. `connectors`, `skills` and `workspace` are grants: what the agent may reach, and whether a session gets a checkout on its own branch.

A change to any of that arrives as a diff. Someone widens a connector grant, and the line shows up in the change request beside the reason for it. Behavior sits in `agents/kortix.md`, a markdown file a person can read without opening the product.

Session work reaches `main` through a change request, and merge is default-deny for agents. Run it on Kortix Cloud, in your VPC, or on your own on-prem network, and self-host is free. Any model provider works with your own keys, or the ChatGPT plan you already pay for.

## Where Perplexity is the better buy

Perplexity's strengths are real. The hosted agent works on day one, on the device people already use, with 400+ connectors and Office 365 within reach on Windows. Enterprise plans state that company data is not used for training. Nobody has to maintain a repository or learn what a sandbox image is. If the job is one capable assistant for one person, Personal Computer is the shorter path, and no security review will pull that work apart.

## When to pick which

Pick Perplexity Personal Computer if you want an assistant on your own machine this week, and the app is a fine place for the settings to live.

Pick Kortix if the agent work has to survive a security review and a change of vendor. Many agents then run on one configuration, in a repository your team reviews, on a deployment you can keep in your own network.

For the wider field, [the open-source Perplexity Computer alternatives](/blog/open-source-perplexity-computer) covers what each option runs on, and [the cloud Computer comparison](/blog/kortix-vs-perplexity-computer) takes the subscription route apart.

Kortix starts free, and the code runs on your own hardware when you want it to. The plans and credit rates are on the [pricing page](/pricing), and your first agent is one repository away: [Get started](https://kortix.com).
