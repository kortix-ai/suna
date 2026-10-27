---
title: "Open-source Lindy alternative: what keeps running when the credits stop"
description: "Lindy bills every active seat and stops when the credits run out. Kortix is open source, and the agent's files and review gate stay in your repo"
date: "2026-10-13"
canonical: "https://kortix.com/blog/open-source-lindy-alternative"
author: "team"
tags: ["Comparisons"]
updated: "2026-10-22"
slug: "/open-source-lindy-alternative"
---
Lindy puts a working agent in Slack within an afternoon and gives the first week away free; Kortix, the open-source AI Operating System, is what a team still holds when that week ends. The agent's instructions, its memory and its review gate sit in a repository the team owns. Rent or own comes down to what stops when the credits do. The files answer that question faster than the invoice.

```logos
label: 'Compared here:'
items:
  - { name: Lindy, domain: lindy.ai }
```

## What Lindy sells you

Lindy runs in Lindy's cloud and plugs into the apps a team already uses. A message in Slack or an email comes back as finished work: a triaged queue, a drafted reply, a competitor report ([Lindy](https://www.lindy.ai)). Nothing is installed, and there is no copy to run on your own hardware. For a team that wants an agent where its people already are, that is most of the wish list.

- **A free week, no card.** $50 of credits lasts seven days, and Lindy grants it once per teammate rather than once per workspace ([Lindy pricing](https://www.lindy.ai/pricing)).
- **Every active user is a billed seat.** A seat adds its monthly credits to one pool the whole workspace draws from. Admins can cap a seat's share, and the monthly credits expire at the next cycle ([Lindy pricing](https://www.lindy.ai/pricing)).
- **Top-ups at $10 per 1,000.** When the pool runs low, credit-using actions pause until the cycle resets or an admin buys more ([Lindy pricing](https://www.lindy.ai/pricing)).
- **Approval on outside impact.** Sending an email, updating a ticket, posting to another channel, publishing a doc: each waits for a person, while read-only lookups go ahead ([Lindy pricing](https://www.lindy.ai/pricing)).
- **Models per task, and a compliance story.** Most major models can be picked for a task, and data is encrypted and never used to train models. Enterprise adds SSO, audit logs and HIPAA under a signed BAA ([Lindy pricing](https://www.lindy.ai/pricing)).

The entry seat is $29.99 a month for 3,000 credits ([Lindy pricing](https://www.lindy.ai/pricing), checked October 2026).

## What ends when the credits do

- **There is no copy to run.** Lindy's product is its cloud: no self-host, no repository, no source for a security reviewer to open ([Lindy](https://www.lindy.ai)).
- **The seat is the unit of cost.** Adding a person adds a bill, whether or not the work grows ([Lindy pricing](https://www.lindy.ai/pricing)).
- **Monthly credits expire.** They refresh at the start of the next cycle; only credits an admin bought as a top-up stay yours until used ([Lindy pricing](https://www.lindy.ai/pricing)).
- **Billing stops, and so does the work.** The workspace stays active through the cycle already paid for, and after that credit-using actions stop ([Lindy pricing](https://www.lindy.ai/pricing)).
- **The model list belongs to Lindy.** A task picks one of the models Lindy offers, and Lindy decides what is on that list.

Getting the instructions right takes weeks of small corrections, and Lindy is fair about where those corrections land. Its memory and its saved skills are plain files: you can open the memory folder, read what the agent remembers and edit it like a document ([Lindy](https://www.lindy.ai)). Lindy gives those files a history too. Each one opens with Preview, Raw and History tabs. Every save counts as a version, and an earlier revision can be restored whenever you want, deletions included ([Lindy docs](https://docs.lindy.ai/teammate/memory)). The rest of it stays inside Lindy's workspace. There is no repository to clone and no branch to work from. A change lands without a diff a teammate approves. Nothing moves the whole system, files and history together, onto another machine.

## Side by side

```compare
them: Lindy
rows:
  - dimension: Time to a working agent
    them: Minutes, in Slack, nothing to install
    kortix: An install, a repository, a first session
    lean: them
  - dimension: What it is
    them: Hosted agent billed per seat
    kortix: Open-source system your team runs
    lean: both
  - dimension: Open source
    them: 'No'
    kortix: Yes
    lean: kortix
  - dimension: Where it runs
    them: Lindy's cloud only
    kortix: Kortix Cloud, your VPC, or on-prem
    lean: kortix
  - dimension: Where the setup lives
    them: Lindy's workspace, per-file versions
    kortix: Your git repo, versioned
    lean: kortix
  - dimension: Pricing shape
    them: Per-seat credits, one shared pool
    kortix: Free tier, credits from $50 a month
    lean: kortix
  - dimension: Model choice
    them: Models Lindy offers, per task
    kortix: Any provider, your keys
    lean: kortix
```

## What a repo keeps

In Kortix the agent is a file tree. Its prompt is `agents/support-triage.md`, and its skills are folders under `skills/`. `kortix.yaml` at the root records which connectors the agent may reach, what wakes it and what each call is allowed to do ([Kortix docs](https://kortix.com/docs/project/manifest)).

```yaml
# yaml-language-server: $schema=https://kortix.com/schema/kortix.v2.schema.json
kortix_version: 2
default_agent: support-triage
connectors:
  - slug: zendesk
    provider: composio
    app: zendesk
    policies:
      - match: zendesk.delete_ticket
        action: block
agents:
  support-triage:
    file: agents/support-triage.md
    connectors: [kortix_slack, zendesk]
triggers:
  - slug: morning-triage
    type: cron
    cron: "0 0 8 * * 1-5"
    timezone: Europe/Berlin
    prompt: Triage the overnight support queue and open a change request with the digest.
```

`kortix validate` reads that file before a push, and the same schema check runs at the merge. An agent `connectors` entry the top-level block never declares is a validation error. That error blocks the push or the merge ([Kortix docs](https://kortix.com/docs/project/manifest)). Session work reaches `main` through a change request, and merge is default-deny for agents. The overnight digest waits for a teammate before it changes anything ([Kortix docs](https://kortix.com/docs/git)).

What survives a budget cut is that tree. The prompt, the skills, the connector rules and the schedule all come with it. So do the memory files and the change requests that shaped them. Point the repository at another machine, or at a fresh instance, and the agent resumes under the same rules.

## The bill follows the machine

Run it on Kortix Cloud, in your VPC, or on your own on-prem network. Self-host is free. Models come from wherever you already buy them: any model provider with your own keys, or the ChatGPT plan you already pay for ([Kortix docs](https://kortix.com/docs/project/models)).

Pricing works the same way. Free is $0 with 500 credits per month, every feature and 1 project, on the user's own provider keys or ChatGPT subscription. Managed models are on the Credits plan only. The paid plan is credits at one rate, 100 credits per dollar, so 5,000 credits a month costs $50. Members are unlimited and free, and the account shares one credit pool. Unused monthly credits roll over one month ([Kortix pricing](https://kortix.com/pricing), checked October 2026).

Thirty people on Lindy are thirty billed seats, whether the work grows or not. Thirty members on Kortix cost nothing, and the invoice tracks what the machine spent.

## Other open-source options

Kortix is the recommendation for a team that wants the whole setup in one repository. It is not the only open-source answer to a hosted agent. Activepieces puts chat, agents, flows, tables and 760+ apps in one workspace. It runs on its own cloud, your servers or an air-gapped install. Its Community Edition is MIT-licensed, and its enterprise features sit under a commercial licence beside it ([Activepieces on GitHub](https://github.com/activepieces/activepieces)). Its builder hands an agent a job in plain words and lets it work out the steps across the apps you connected. Gates hold the steps that touch money, customers or production ([Activepieces](https://www.activepieces.com)). The two part company on where the work is defined. Activepieces keeps a team's automations in its workspace and its builder. A Kortix project keeps the agent's instructions and connector rules in a repository, where a change arrives as a diff a teammate approves.

## When to rent and when to own

Rent Lindy for the job that has to ship this month. The free week covers the trial, approvals cover anything that leaves the building, and nobody has to run a server. A team that treats the agent as a convenience does well out of that arrangement.

Own the system once the agent becomes plumbing. A budget cut, a vendor change or a security questionnaire should not take the instructions with it. A useful test is what a new hire would read to understand how the agent decides. At Lindy that is a login and a folder inside Lindy's workspace, with the memory and skills you can read and rewrite. At Kortix it is a repository at a commit, with the manifest and the change requests that shaped it.

More from the blog: [open-source Manus alternatives](/blog/open-source-manus-alternatives) and [Kortix vs Perplexity Computer](/blog/kortix-vs-perplexity-computer).

Kortix is free to start and free to self-host. Clone the repo and run a session on your own machine or in the cloud. Keep the review step with a person: [Get started with Kortix](https://kortix.com).
