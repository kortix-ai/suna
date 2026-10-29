---
title: "Is Kortix free? Open source, free to self-host, metered in the cloud"
description: "Kortix is open source and free to self-host; on Kortix Cloud, credits from $50 a month pay for the agent computer by the second."
date: "2026-09-25"
canonical: "https://kortix.com/blog/is-kortix-ai-free"
author: "team"
tags: ["Product"]
updated: "2026-10-22"
slug: "/is-kortix-ai-free"
---
Yes, Kortix is open source and free to self-host. The cloud version is metered by the work an agent does, not by how many people can sign in. The whole system lives in a git repository you can clone and run on your own server. Kortix Cloud adds a credit balance that pays for a cloud computer per second while an agent works and stops charging when that computer sleeps.

## The software is free to keep

Kortix is open source. Read it, fork it, audit it ([Kortix on GitHub](https://github.com/kortix-ai/suna)). Self-hosting carries no fee to Kortix. `kortix self-host init` and `kortix self-host start` install a Docker Compose stack on a Linux server you control. Billing is off by default: no credits, no plan limits and no managed models ([self-hosting docs](https://kortix.com/docs/host)). You still pay the companies that supply the metal and the tokens. Sessions run on Platinum, the reference compute provider, and each project adds its own model key in the app. Those two bills exist on any host, including ours.

## What the Free plan includes

The cloud Free plan is $0 and asks for no card. It includes 500 credits a month and 1 project, and it runs on your own provider keys or the ChatGPT subscription you already pay for ([Kortix pricing](https://kortix.com/pricing), checked October 2026). Managed models are a Credits feature: on Free, every Kortix-managed model returns `plan_upgrade_required`, and the monthly credits pay for compute and your own models only ([plans and credits](https://kortix.com/docs/credits), checked October 2026). On Credits, the balance pays for the agent computer and for Kortix models, which are DeepSeek and GLM, with zero data retention at the model provider. The grant refills every month. It buys agent-computer time the same way a paid balance does.

## Credits buy work, not headcount

The paid plan is Credits. $50 buys 5,000 credits a month at 100 credits per dollar. A larger monthly amount buys more credits at that rate, never a cheaper credit ([plans and credits](https://kortix.com/pricing), checked October 2026). One wallet serves the whole account. Members are unlimited and adding one does not change the bill.

Unused plan credits roll over for one month, and top-ups never expire. A quiet month is not a loss. The paid plan also raises the project ceiling to 200, lifts model rate limits, and adds email support.

## What the meter counts

The meter follows three things: the computer, the model, and the tools that go through Kortix. Compute is the reserved size of the sandbox multiplied by the seconds it is active. The default 2 vCPU / 4 GB / 20 GB machine costs about $0.11 an hour, or about 11 credits ([plans and credits](https://kortix.com/docs/credits)). A stopped or sleeping sandbox accrues nothing.

| What runs | How it is metered | What pays |
| --- | --- | --- |
| Sandbox compute | Reserved vCPU, memory and storage, per second | Credits |
| Managed model calls | Provider base price plus a 5.5% platform fee | Credits |
| Your own model key | No Kortix fee to $1,000 a month, then 5% | Your provider, then credits |
| ChatGPT subscription | Never charged by Kortix | Your subscription |
| Kortix-proxied tools | Each search or scrape request | Credits |

Model calls split by source. Managed models bill tokens at the provider's base price plus a 5.5% platform fee. On your own key, Kortix charges nothing for the first $1,000 of monthly usage and 5% of each request's list price after that. A ChatGPT subscription, or OpenCode Go, is never charged. Both paths stay open on every plan: any model provider with your own keys, or the ChatGPT plan you already pay for. Searches and page fetches that Kortix proxies are metered per request.

Two details matter when you forecast. The meter counts the size a sandbox reserves, not the CPU it actually uses, so a smaller spec is the first lever. And a run needs a positive balance. Work that finishes is always recorded. New work does not start at zero.

## Self-hosting moves the bill to your hardware

Self-hosting runs the open-source AI Operating System on a server you control, and it removes the credit balance entirely. The stack is frontend, API, LLM gateway, Supabase and Caddy, all in one Compose project. The daily updater pulls new images, migrates the database and rolls the services ([self-hosting docs](https://kortix.com/docs/host)). There are no managed models, so every project brings a provider key. Sessions still run on a cloud sandbox provider that you pay directly.

```sh
curl -fsSL https://kortix.com/install | bash
kortix self-host init --domain kortix.example.com --admin-email you@example.com
kortix self-host start
```

The trade is operational. You own upgrades, backups, TLS and the database. `kortix self-host doctor` checks the install, and `kortix self-host rollback --release <version>` returns to an earlier image, but the server is yours to run. Run it on Kortix Cloud, in your VPC, or on your own on-prem network. Self-host is free.

## When the credits run out

At zero, agents pause and triggers stop starting sessions. Starting a session or sending a prompt returns `402` with `insufficient_credits`, and Kortix stops the account's running Apps ([plans and credits](https://kortix.com/docs/credits)). On Free, the fix is to wait for the next monthly grant or move to Credits. On a paid plan, add credits or turn on auto top-up. With auto top-up off, owners get one email per UTC day while the balance stays empty. The non-expiring balance can go below zero for work that finished, and the next credits cover the difference.

## How to choose a starting point

Start on Free if you want to give one project a real task and watch what the agent does with it. Move to Credits when one project and the 500 credits a month no longer cover the work; the plan raises the grant, lifts the project ceiling to 200 and turns managed models on. Self-host when the requirement is structural. The control plane, the database, the files and the secrets have to sit on disks you control, the instance must sit inside your VPC, or the platform has to be auditable line by line. Agent sessions still run on a rented Platinum sandbox outside that server. Where the data itself has to stay on your network, that is an Enterprise conversation rather than a self-host install. Free and Credits share one account, so the move between them is a billing change.

Two related reads: [Kortix vs Claude Cowork](/blog/kortix-vs-claude-cowork) covers the hosted option this billing model is measured against, and [Getting started with open-source Kortix](/blog/getting-started-with-kortix) has the first three commands.

Start with [Kortix](https://kortix.com): free to start, free to self-host.
