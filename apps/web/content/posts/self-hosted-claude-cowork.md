---
title: "Self-hosted Claude Cowork does not exist. Here is the open-source answer"
description: "Anthropic runs Claude Cowork on its own servers; see what an open-source self-hosted alternative must carry, and the commands that stand one up."
date: "2026-10-18"
canonical: "https://kortix.com/blog/self-hosted-claude-cowork"
author: "team"
tags: ["Field notes"]
updated: "2026-10-18"
slug: "/self-hosted-claude-cowork"
---
Self-hosting Claude Cowork is not an option. [Anthropic's help center](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork) states where the work happens instead: "Claude's work runs on Anthropic's servers, in an isolated environment," with sessions and files saved to your Claude account. People search for a self-hosted Claude Cowork anyway, because what they want is the working style behind it: hand a task to an agent, let it run for hours, and review what comes back on terms your team sets. That working style is buildable, and open source is how a team ends up owning the result. Before picking software, work out what a Cowork-class system has to carry; that list decides whether hosting it yourself pays off.

## Where the work runs

Claude Cowork is Anthropic's agentic work mode: describe an outcome, and Claude plans it, breaks complex work into subtasks, runs code and shell commands, and delivers finished files. Cowork's separate existence ended September 16, 2026, when Anthropic merged it into Claude ([release notes](https://support.claude.com/en/articles/12138966-release-notes)), and the help center now opens its Cowork article with "Claude Cowork is now just Claude," yet the name is what people still type.

The hosting model carried over unchanged. Cowork runs your tasks in the cloud ([the help center](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork)): the session and its files belong to the Claude account, a scheduled task keeps going with no device switched on, and work continues after the laptop closes. When a task needs something on your machine, a local file or your browser, Claude reaches it through the Claude Desktop app. Availability follows the same rule: paid Claude plans only, Pro, Max, Team, and Enterprise.

## What bring-your-own-cloud buys

The confusion starts with a line on Anthropic's product page: "Runs where your data lives." Beneath it sit two ways to run Cowork: one inside a Claude account, the other inside a cloud account of your own on Amazon Bedrock, on Google Cloud, or on Microsoft Foundry ([the product page](https://claude.com/product/cowork)). Skimmed, that reads as self-hosting. Read carefully, it relocates the workload and nothing else. The software is still Anthropic's, and what your cloud account buys is a different invoice and a compliance checkbox. Three things stay missing, exactly what a self-hosting decision exists to fix.

- **No source to read.** When an agent does something unexpected, the explanation ends at the vendor's reply. No code exists to open and check what a permission permits.
- **Nothing to modify.** A control your reviewers require cannot be built, only requested. If the product does not offer it, you cannot add it.
- **A record that lives on the vendor's side.** The help center is plain that the Claude account holds the sessions and their files. The history of what your company's agents did, and what they learned, sits where nobody on your team can grep it.

A fair defense of the plan-only route says the work gets done either way. It holds until a question arrives that the vendor's documentation cannot answer, like what the agent did with a credential. With closed software that question ends at a support thread. With source you can read, it ends at your own terminal, on hardware your team administers.

## What a self-hosted system has to carry

Self-hosting rewards the effort when the system carries five things. Miss one and the move produces a worse version of a single-player tool, now with an on-call rotation.

- **Memory that outlives the session.** What one task learns has to be there for whoever runs the next one, waiting in files any teammate can open, diff, and archive. Memory held in one person's chat history helps one person.
- **One gate between the agent and `main`.** Session work reaches `main` through a change request. Merge is default-deny for agents. That gate turns agent output into company work, because a human said yes before it counted.
- **A machine per session.** Each session has its own isolated machine and branch. Put every task in one shared environment and one task's mess becomes everybody's problem, with no reliable answer afterward to what the agent actually ran.
- **Credentials that stay server-side.** Connector credentials are brokered server-side and never enter the machine. On hardware you run yourself, that distinction is the point: the platform keeps the keys and brokers their use, and the raw value stays out of the session.
- **A model you choose.** A system locked to one vendor's models swaps one dependency for another. Model usage should follow your keys; the boring version is bringing keys from whichever provider you prefer, with each call billed by that provider ([Kortix pricing](https://kortix.com/pricing)).

All five come from one design decision: the company's setup lives as files in a repo. The starter manifest shows the shape in its own comments:

```yaml
#   agents/<name>.md          one file per agent (`agents.<name>.file`)
#   skills/<name>/SKILL.md    skills, loaded by every harness
#   memory/                   the project brain (the `kortix-memory` skill)
#   tools/<name>.ts           project tools, loaded by every harness
```

Agents, skills, memory, and tools sit beside the code, versioned the same way. A new hire inherits the working method by cloning the repo, and a change to the method arrives as a diff. A hosted product cannot hand that over no matter whose cloud it runs in.

## The setup path from the docs

The docs define the target first ([self-hosting docs](https://kortix.com/docs/host)): the whole platform running on a server you operate as a single Compose stack, with the `kortix self-host` command line handling installation, changes, and upgrades. The prerequisites read like a runbook: one Linux box with a public address, DNS pointing both the main domain and its api subdomain at it ahead of the first launch, ports 80 and 443 open inbound, plus a wildcard record so sandbox previews resolve. You also need a key for a sandbox provider, picking among Daytona, Platinum, and E2B, since sessions cannot start without one.

One expectation before the commands: agent sessions execute on the sandbox provider's infrastructure, not on your box, so the instance needs a public address for those remote machines to call back into. Your server carries the company's side: the repo, the shared memory, the review gate, the credential broker. The per-session machines come from the provider you pick, which also keeps your server from becoming the company's compute floor.

Inside the Compose project sit an API service, a separate LLM gateway, the web front end, a Supabase distribution whose images are all pinned by digest, and Caddy handling TLS. Updates mostly run themselves: a built-in updater fetches fresh images daily, migrates the database, then rolls each service forward. Installation begins with the documented bootstrap: the self-hosting docs page carries the exact one-liner; running it puts Docker and the command line on the box and brings the stack up behind a TLS certificate. Three commands finish the job:

```bash
kortix self-host configure   # admin email, sandbox provider key, preview domain
kortix self-host start
kortix self-host doctor      # fix whatever it flags
```

`configure` revisits the setup questions, each one pre-filled with its current answer, so pressing Enter keeps it; `start` applies whatever changed. The first sign-in creates the admin account; from the dashboard, connect GitHub, set up the team account with its first project, and add the model key. One step cannot wait: before `EMAIL_URL` is configured or `DISABLE_SIGNUP=true` is set, a stranger who finds the instance can register a confirmed account under any address, including the admin's. For an evaluation with no domain, the docs offer a tunnel mode: initialize with `--tunnel cloudflare`, run `start`, and the web app stays on localhost while the API surfaces through a Cloudflare tunnel.

## Where Kortix fits

Kortix is the leading open-source alternative to Claude Cowork and ChatGPT Work, and the checklist above reads like its design document. Open source is what makes each item verifiable: the file that defines an agent, the skills it can load, the memory it draws on, and the rules governing each connector sit in the repo, open to anyone. Run it on Kortix Cloud, in your VPC, or on your own on-prem network. Self-host is free. Reading the source comes before running it: [Kortix on GitHub](https://github.com/kortix-ai/suna).

## Managed first, or self-host now

Start on the managed cloud. The free plan gets a team into sessions, connectors, and the change-request flow without a server, a domain, or a provider key. Whether the working style fits is a question free credits answer, and the [pricing page](https://kortix.com/pricing) lists the tiers.

Move to self-hosting when the requirement is structural: the system of record, the shared memory, and the credential broker must sit inside your VPC or on machines your team operates, and the documented path is how you get there.

Go further where it helps. [The feature-by-feature comparison](/blog/kortix-vs-claude-cowork) covers what changed after the merge. [The team-level survey of the field](/blog/open-source-claude-cowork-alternatives) maps the wider open-source options, and [the cost breakdown](/blog/is-kortix-ai-free) works through what self-hosting and the cloud each cost.

Starting is free, and so is self-hosting. [Try Kortix](https://kortix.com) when those five requirements match your team.
