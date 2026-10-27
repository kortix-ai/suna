---
title: "Kortix vs Vellum: the second colleague needs an open-source repo"
description: "Vellum is a personal assistant one person shapes, its cloud closing 2 November 2026; Kortix is the open-source AI Operating System a team owns in a repo."
date: "2026-10-14"
canonical: "https://kortix.com/blog/kortix-vs-vellum"
author: "team"
tags: ["Comparisons"]
updated: "2026-10-22"
slug: "/kortix-vs-vellum"
---
Vellum is a personal assistant that one person names and shapes, while Kortix is the open-source AI Operating System: your agents, their skills, your company memory, and every connector in one git repo you own, with the agents working on real cloud computers. Vellum's hosted platform closes on November 2nd, 2026, which leaves the comparison with two questions: who the assistant belongs to, and who keeps it running after that date ([Vellum](https://www.vellum.ai/vellum-assistant-platform-shutdown)).

## What Vellum does well

- **A personality that gets written down.** The assistant's identity sits in plain text files, and onboarding watches how you write before it fills in `IDENTITY.md` and `SOUL.md` ([Vellum docs](https://www.vellum.ai/docs/key-concepts/the-workspace)).
- **Memory with structure.** Eight kinds of memory, from episodic to procedural, each with a staleness window, so context survives weeks ([Vellum Assistant](https://github.com/vellum-ai/vellum-assistant)).
- **Approvals that hold under pressure.** A separate process outside the sandbox grades each tool call low, medium or high risk, and the approval button is hard-coded rather than judged by the model ([permissions model](https://www.vellum.ai/docs/trust-security/the-permissions-model)).
- **A surface for every habit.** macOS, Windows, iOS, the web app, voice, email, Telegram, Slack, Twilio and a terminal, all sharing one memory ([Vellum Assistant](https://github.com/vellum-ai/vellum-assistant)).
- **A harness you can read.** The assistant harness is MIT-licensed, runs on your own hardware and carries the whole product if the service goes away ([Vellum Assistant](https://github.com/vellum-ai/vellum-assistant)).

Its docs describe the assistant as personal, "not a team tool", "not a shared resource" ([Vellum's docs](https://www.vellum.ai/docs/getting-started/what-is-vellum)). That shape is deliberate, and it is where the trouble starts once a team arrives.

## The cloud has an end date

Vellum shuts its Personal Assistant platform down on November 2nd, 2026. Assistants hosted in Vellum's cloud stop working that day, logins end, and the data is deleted. Active subscriptions are cancelled and refunded pro rata ([shutdown notice](https://www.vellum.ai/vellum-assistant-platform-shutdown)).

The harness survives the shutdown. It is fully open source, and an assistant that never created a Vellum account keeps working indefinitely on your own keys and OAuth apps. Vellum will not maintain the repo or cut new releases, so its founding engineer now maintains a rebranded fork called Cadet ([Cadet](https://github.com/vargasjr-dev/mycadet-temp)). A hosted assistant can move to a local machine through a Teleport button Vellum calls not fully battle tested.

Vellum's shutdown leaves a buyer choosing between an assistant they run themselves and a hosted service with an end date. Kortix sells both at once. Run it on Kortix Cloud, in your VPC, or on your own on-prem network. Self-host is free.

## Where one person's assistant stops

Vellum's workspace is a folder of plain text. `IDENTITY.md` says who the assistant is, `SOUL.md` how it behaves, `USER.md` what it knows about you. On the desktop app the folder lives at `~/.vellum/workspace/`. On Cloud it is isolated to one account and edited through the web app ([Vellum docs](https://www.vellum.ai/docs/key-concepts/the-workspace)).

That placement turns into a problem the moment a team arrives. The personality, the memory store, the trust rules and the risk tolerance all hang off one assistant. One person holds guardianship of it. A second colleague gets two options: use the first person's account, or hatch a second assistant and teach it the same lessons again. Neither gives both people one place to read what the assistant may do.

A company rule such as mail going out from the shared inbox is, on a personal assistant, one person's risk setting. The colleague finds out when the assistant gets it wrong.

## The setup a second colleague can read

Kortix keeps a project's configuration in a `kortix.yaml` manifest and one markdown file per agent, both in the project's git repo. The starter manifest explains the split in its own header: the `agents:` map is `governance only`, holding the connectors, secrets, permissions, skills and workspace grants alongside `file`, the path of the agent's markdown file, while agent behavior "lives entirely in that `.md`" ([starter manifest](https://github.com/kortix-ai/suna/blob/dev/packages/starter/templates/base/kortix.yaml)).

```yaml
agents:
  kortix:
    file: agents/kortix.md
    connectors: all
    secrets: all
    kortix_permissions: all
    skills: all
```

Those five lines grant the default agent everything, which is how a new project starts capable. The same header explains the other direction: a grant left out of the manifest resolves to none, "so a scoped specialist starts locked down". A support agent that may read the ticket queue and nothing else is one more markdown file with two grants. That change arrives as a diff a teammate can review before it takes effect.

Vellum's setup is also files, and good ones, but they sit in one account's workspace. Kortix's sit in a repo, so the second colleague clones it and starts with the same context.

## Work lands as a diff

The starter agent file calls the session an isolated sandbox and "an ephemeral branch of this repo", where "Only what you commit + push survives" ([starter agent](https://github.com/kortix-ai/suna/blob/dev/packages/starter/templates/base/agents/kortix.md)). Session work reaches `main` through a change request. Merge is default-deny for agents. A teammate therefore reads the result the way they read code: a diff, with the agent's reasoning behind it and a rollback one commit away.

Per-resource permissions for people and agents. Roles, groups, and an audit trail. Every action is recorded. Reading, exporting and streaming the audit log depend on the plan.

## Where Vellum is still the better pick

For one person willing to run the harness, Vellum remains the lighter assistant. Download the desktop app, name it, teach it, and it follows you between a Mac, a phone and a terminal. Self-hosting costs hardware and your own model keys, and the workspace, git history included, belongs to one person, with no project-wide manifest and no change-request gate a teammate reviews.

The hosted version is the part with an expiry. Plans run $30, $100 or $200 a month, they stop with the cloud on November 2nd, and the data goes with them ([Vellum pricing](https://www.vellum.ai/pricing)). A solo operator with a spare machine can accept that trade. A team that needs the assistant to exist next year without anyone's laptop staying open cannot.

## Side by side

| Dimension | Kortix | Vellum |
| --- | --- | --- |
| Open source | Yes, the whole platform | MIT, the assistant harness; the cloud platform is closed |
| Self-host | Yes, free | Yes, the harness keeps working |
| Hosted service | Kortix Cloud, or your own infrastructure | Ends November 2nd, 2026 |
| Where setup lives | `kortix.yaml` and agent files in git | Plain-text workspace on one account |
| Model choice | Any model, your own keys | Anthropic, OpenAI, Gemini, Ollama |
| Price shape | Free at $0, credits from $50 | Self-host free; hosted plans $30 to $200 a month |
| Memory | Company memory as files in the repo | Eight memory types about one person |
| Channels | Slack, Microsoft Teams, email | Mac, Windows, iOS, web, voice, Slack, Telegram |

## How to choose, by your situation

Pick Vellum if you are one person who will run the harness yourself, on a Mac, a Windows PC or a VPS, and you accept owning the model keys and the backups. The files are plain text, so a move is a copy and a config edit.

Pick Kortix when the assistant has to outlive one person's machine, or when two people have to agree on what it may do. The paid plan starts at $50 a month with unlimited members sharing one credit pool. The free plan gives one project 500 credits a month ([Kortix pricing](https://kortix.com/pricing)).

If you are still drawing the line between a personal assistant and a company system, [personal AI agents vs a company OS](/blog/personal-ai-agents-vs-company-os) covers the same question across other tools. [Kortix vs OpenClaw](/blog/kortix-vs-openclaw) takes the single-operator case further.

Free to start, free to self-host. [Try Kortix](https://kortix.com).
