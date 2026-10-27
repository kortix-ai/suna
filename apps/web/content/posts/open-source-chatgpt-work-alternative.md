---
title: "The open-source ChatGPT Work alternative that lives in your repo"
description: "ChatGPT Work ships with every ChatGPT plan; Kortix is the open-source alternative whose agents, grants and memory sit in a git repo your company owns."
date: "2026-10-05"
canonical: "https://kortix.com/blog/open-source-chatgpt-work-alternative"
author: "team"
tags: ["Comparisons"]
updated: "2026-10-22"
slug: "/open-source-chatgpt-work-alternative"
---
ChatGPT Work is a capable agent inside OpenAI's product, and the open-source alternative is Kortix, the open-source AI Operating System a company can run on its own infrastructure. Each agent lives in a markdown file under `agents/`, with its own block in `kortix.yaml`. The question a buyer actually asks is who can read an agent's instructions and who approves a change to them, and what each option costs before the first agent runs.

```logos
label: 'Compared here:'
items:
  - { name: ChatGPT Work, domain: openai.com }
```

## What ChatGPT Work gets right

OpenAI launched ChatGPT Work on July 9, 2026 as an agentic mode inside ChatGPT, powered by GPT-5.6. OpenAI describes it as an agent that acts across your apps and files, stays with a project for hours and turns a goal into finished work ([OpenAI announcement](https://openai.com/index/chatgpt-for-your-most-ambitious-work)).

- **It returns a deliverable.** Hand it a goal and a document, a spreadsheet or a presentation comes back, not a chat reply.
- **It holds a long task.** A single piece of work can stay with a project for hours without a person driving each step.
- **It sits where the team already works.** ChatGPT Work is a mode inside ChatGPT, so the login, the billing and the habits are the ones people have.
- **The model ships with the agent.** GPT-6 Astra is available in ChatGPT Work ([OpenAI](https://openai.com/index/gpt-6-astra-next-generation-work)). The GPT-6 Pro model needs Pro, Business or Enterprise ([OpenAI Help Center](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex)). [GPT-6 Astra for agent teams](/blog/gpt-6-astra-for-agent-teams) goes further on that.

## Where the shape stops working

ChatGPT Work is closed source and runs in OpenAI's cloud, with no self-host. Access arrives through OpenAI's plans.

- **One vendor sets the models.** Work runs OpenAI's models, and which one you get depends on the plan you bought.
- **Configuration lives in the OpenAI workspace.** Agents, instructions and context are set up inside OpenAI's product and its admin console.
- **Access is metered.** Usage draws on the plan's allowance, and credits buy more.

## Every plan carries Work; the team floor is two seats

Work comes with every ChatGPT plan. OpenAI's launch post puts the desktop app's three modes, Chat, Work and Codex, on every plan, Free included ([OpenAI](https://openai.com/index/chatgpt-for-your-most-ambitious-work)). Free and Go get a limited desktop version, and Plus adds desktop, web and mobile ([ChatGPT pricing](https://chatgpt.com/pricing), checked October 2026).

Business is the team plan that carries Work for a company, and it is where the floor appears. Standard seats cost $20 a seat a month on annual billing, or $25 month to month ([OpenAI Help Center](https://help.openai.com/en/articles/8792828-chatgpt-business-overview), checked October 2026). Premium seats cost $100 and $125, with five times the usage and no five-hour cap. Every Business workspace needs at least two seats, so the smallest real bill is two Standard seats: $40 a month annually, $480 a year, or $50 a month monthly, $600 a year. Usage sits on top, and OpenAI's API bills separately.

Free, Go and Plus suit one person trying the agent. A company that wants shared context, admin controls and central billing lands on Business, and Business starts at two seats.

Kortix puts the money on credits instead. Free is $0 with 500 credits per month, every feature and 1 project, on the user's own provider keys or ChatGPT subscription. Managed models are on the Credits plan only. Above the free tier, credits are bought at 100 credits per dollar, so a plan starts at 5,000 credits a month for $50, and they land in one wallet that unlimited members share at no per-member charge. Unused monthly credits roll over one month ([pricing](https://kortix.com/pricing), checked October 2026). A credit buys the agent computer, which bills per second while it runs and costs nothing while it is stopped. Two Business seats come to $40 a month billed annually, and the Kortix paid plan starts at $50 a month in credits, so the two bills start close together.

## Agents you can read, changes a person approves

One repo holds the project, and its manifest names the connectors, the triggers, the sandbox image and how far each agent can reach. The agent's behavior sits in its markdown file next to the manifest, and the skills it draws on are markdown files too.

```yaml
# kortix.yaml: the company, as files
kortix_version: 2
default_agent: support-triage
agents:
  support-triage:
    file: agents/support-triage.md
    connectors: all
triggers:
  - slug: daily-digest
    type: cron
    cron: "0 0 9 * * 1-5"
    prompt: Summarize this week's open support tickets.
```

`kortix_version` pins the schema the file is read against. `default_agent` names the agent a session or trigger runs as when it names none, so the weekday digest above belongs to `support-triage` without repeating its name. The `prompt` is the instruction the trigger hands that agent, and a trigger with an empty one fails validation.

A manifest that leaves out `connectors`, `secrets`, `apps` or `kortix_permissions` grants none of them. Two keys behave differently: an omitted `tools` grants every tool, and an omitted `skills` leaves skill access to the agent file's own permission rule. A grant widened from a session reaches `main` through a change request. The dashboard or `kortix agents config` writes the same grant into `kortix.yaml` and commits the default branch at once, so a wide grant can land there without anyone approving it first ([docs](https://kortix.com/docs/project/agents)). Either way the file is the record, and reading the repository answers the question a buyer asks after an incident: what was this agent told, which connectors could it call, and when did that last change.

Work lands the way it was configured. Session work reaches `main` through a change request. Merge is default-deny for agents: nothing merges itself unless an admin granted the merge capability, `project.gitops.merge` ([docs](https://kortix.com/docs)). The starter agent ships with `kortix_permissions: all`, so it holds that grant out of the box. The grant is the setting to watch: it decides whether a change reaches `main` without a person reading it first. Take it off the list and every merge waits for a person.

The model stays your choice. Any model provider with your own keys. Or the ChatGPT plan you already pay for. Hosting too: run it on Kortix Cloud, in your VPC, or on your own on-prem network. Self-host is free.

## Where ChatGPT Work is the better pick

For a person who wants a finished deck this afternoon, ChatGPT Work wins on the first minute. There is nothing to install, no repository to adopt, and no review process to agree with anyone. The agent, the model and the subscription arrive as one product, and a team already paying for ChatGPT gets the mode without a migration.

## What the two systems do differently

```compare
them: ChatGPT Work
rows:
  - dimension: Open source
    them: "No"
    kortix: Yes, the whole platform
    lean: kortix
  - dimension: Models
    them: OpenAI models, plan-gated
    kortix: Any model, your keys
    lean: kortix
  - dimension: Where it runs
    them: OpenAI's cloud
    kortix: Kortix Cloud, your VPC or on-prem
    lean: kortix
  - dimension: Self-host
    them: "No"
    kortix: Yes, free
    lean: kortix
  - dimension: Configuration
    them: In the OpenAI workspace and admin console
    kortix: Files in a repo you own
    lean: kortix
  - dimension: How work lands
    them: A file returned to the chat
    kortix: A change request; merge is default-deny for agents
    lean: kortix
  - dimension: Smallest team bill
    them: Two seats, $40 a month billed annually
    kortix: Free tier $0; paid credits from $50
    lean: kortix
  - dimension: Time to first result
    them: Minutes, inside ChatGPT
    kortix: A repo to set up first
    lean: them
```

## Which one a company should run

```verdict
themLabel: ChatGPT Work
them: You work inside ChatGPT and want finished deliverables from OpenAI's models on OpenAI's cloud, with no repo to run.
kortix: You want the platform your company owns, on any model, self-hosted or managed, with people reviewing what agents change.
```

Most teams end up with both, and the split is by job rather than by preference. Fast thinking and one-off deliverables stay in ChatGPT, where they cost a seat. Work that repeats on a schedule, reaches the company's own systems and needs a record of who approved it moves to Kortix, because that record lives in the repository next to the agent's instructions.

If the desktop assistants are also on your list, [Kortix vs Claude Cowork](/blog/kortix-vs-claude-cowork) and [what Kortix actually is](/blog/open-source-ai-management-system) go deeper. For the wider category, read the [open-source Microsoft Copilot alternative](/blog/open-source-microsoft-copilot-alternative).

```cta
title: Run the work on a platform you own
body: Free to start; self-hosting is free.
```
