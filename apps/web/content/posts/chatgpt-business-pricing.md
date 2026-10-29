---
title: "ChatGPT Business pricing: a published seat, a bill open source can price"
description: "ChatGPT Business prices seats and leaves the credit rate unpublished; open-source Kortix bills agent compute per second, so a month is known in advance."
date: "2026-10-20"
canonical: "https://kortix.com/blog/chatgpt-business-pricing"
author: "team"
tags: ["Field notes"]
updated: "2026-10-21"
slug: "/chatgpt-business-pricing"
---
ChatGPT Business costs $20 a user a month billed annually, or $25 month to month, and that seat is the only line of the bill OpenAI publishes in full ([OpenAI Business pricing](https://openai.com/business/pricing)). Open-source Kortix prices the rest of it. What scales there is a machine billed by the second, not a credit whose dollar value appears nowhere on the rate card. Here is what each bill publishes, and the part it leaves without a price.

## The seat prices, and the mix that moves them

Premium seats cost $100 a user a month billed annually, or $125 month to month. They carry five times the usage of a Standard seat and drop its five-hour window ([ChatGPT Business overview](https://help.openai.com/en/articles/8792828)). Both types include ChatGPT, ChatGPT Work and Codex. Work is a mode inside the ChatGPT app, not a separate product. Chat and Work sit behind a toggle, and Codex is its own view in the desktop app, with separate history and reach into local folders and repositories ([ChatGPT Work and Codex](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex)).

A workspace needs at least 2 seats, and the types mix freely. A seat is paid capacity, separate from the person using it. OpenAI bills every seat at the start of each cycle whether or not anyone is assigned to it, and reductions land at the next cycle, never below the occupied seats ([managing billing and seats](https://help.openai.com/en/articles/8792536)).

That mix is where a quote goes wrong. A Premium seat lists at $100 a month billed annually against $20 for Standard, for 5x the usage and no 5-hour limit, so the mix is a wager on which people exhaust an allowance first ([Business pricing](https://openai.com/business/pricing)). Guess high and the company prepays capacity nobody uses. Guess low and the difference lands on the credit meter, where the unit price is not on the rate card at all.

## A credit has no printed price

When a seat's included usage runs out, eligible work can continue against credits the workspace bought in advance. If the pool is empty, the feature stops until an owner adds more. The rate card publishes what a task costs in credits: Work and Codex per million tokens, chat features at a fixed count such as 30 credits for an agent-mode message ([ChatGPT rate card](https://help.openai.com/en/articles/11481834-chatgpt-rate-card-business-enterpriseedu-credit-based-pricing)). The rate card never prints what a credit costs in dollars, and the Learn pricing page says so: "Credit purchase prices and applicable discounts depend on your plan or agreement" ([ChatGPT Learn, pricing](https://learn.chatgpt.com/docs/pricing)).

The derivation runs through voice. Desktop voice is billed at $0.05 a minute against the Codex usage budget, and on credit-based billing the same minute costs 1.25 credits, so 1.25 credits buy exactly what $0.05 buys. The same docs put a quantity on that unit: a typical GPT-5.6 Sol task may use 2-15 credits ([ChatGPT Learn, pricing](https://learn.chatgpt.com/docs/pricing)). The rate card adds that actual credit usage varies with the model, task size, input and output mix, automations, fast mode and the number of concurrent Codex instances ([ChatGPT rate card](https://help.openai.com/en/articles/11481834-chatgpt-rate-card-business-enterpriseedu-credit-based-pricing)).

The spend controls are real. Owners set a monthly credit limit per seat type, override it per person, and cap automatic reload; by default no limit is set ([managing credits and spend controls](https://help.openai.com/en/articles/20001155)). A cap converts an open meter into a ceiling, and says nothing about how much work that ceiling buys, because the same task on a different model, at a different reasoning effort or in fast mode costs a different number of credits.

## The seat that left the menu in June

A third seat type existed until recently. A legacy Codex seat carried no fixed monthly fee, drew on workspace credits from the first call, and included no ChatGPT chat. Since June 24, 2026 it is no longer sold to new Business workspaces. An older workspace can add one only if it held one, or a pending invitation, before that date, and it counts toward neither the two-seat minimum nor the 200 paid Standard and Premium seats a subscription allows ([legacy Codex seats](https://help.openai.com/en/articles/20001492)).

Adding a person now starts at $20 a month, with the usage question behind it ([Business pricing](https://openai.com/business/pricing)). A rate card that reorganizes inside a year is a legitimate thing for a vendor to do, and a reason a three-year agent budget written against last year's menu is wrong before the first renewal.

## The ceiling is 200 seats, and above it the price disappears

OpenAI's pricing page describes Business as a plan "for teams of 2-200 employees", attaches the caveat "Unlimited subject to abuse guardrails", and points anything larger at Enterprise. The seat documentation prints the same number from the billing side. Since August 24, 2026 the upper limit is "200 paid Standard and Premium seats total per ChatGPT Business subscription". Unassigned seats count toward it, support cannot raise it, and a workspace created before that date keeps its earlier limit ([managing billing and seats](https://help.openai.com/en/articles/8792536)). A team that outgrows the cap has one route: Enterprise, where pricing is custom and the number arrives by sales conversation ([Business pricing](https://openai.com/business/pricing)).

Self-serve billing is card only; invoicing and net terms are not available. The published price list covers a workspace that pays by card, inside a range that stops at 200 employees, and the first plan that fits a larger company publishes no price at all ([Business pricing](https://openai.com/business/pricing)).

## Where OpenAI is the better buy

If the work is chat, research, decks and documents done inside ChatGPT by people who all hold a license, buy Business: no code to own, no self-host requirement, nobody on staff who wants to run a platform. The seat price is published, the allowance is generous for that work, and the meter lights up only for heavy agent use. We would not try to move that team.

## What the same work costs when the meter counts seconds

Kortix is the open-source AI Operating System: your agents, their skills, your company memory, and every connector in one git repo you own, with the agents working on real cloud computers.

The pricing is built the other way round. Free is $0 with 500 credits a month and one project. Paid credits start at $50 a month, at the same rate on every tier. One credit is $0.01, and eleven buy an hour on an agent computer (2 vCPU, 4 GB), billed per second with nothing charged while it is stopped. $200 a month buys 20,000 credits, about 1,830 agent-computer hours ([Kortix pricing](https://kortix.com/pricing)). Members are unlimited and free, and the account shares one credit pool. Model calls are separate: any model provider with your own keys, the first $1,000 a month free and 5% after, or the ChatGPT plan you already pay for, which spends no credits.

Take the deck build in OpenAI's own walkthrough that "worked for 2m 30s" ([ChatGPT Learn, Work](https://learn.chatgpt.com/docs/get-started-with-work)). At 11 credits an hour ([Kortix pricing](https://kortix.com/pricing)), two and a half minutes of agent computer billed per second comes to 0.46 credits for that task, against 2 to 15 credits for a typical GPT-5.6 Sol task ([ChatGPT Learn, pricing](https://learn.chatgpt.com/docs/pricing)). Credits pay for the agent computer, and with your own keys also 5% of model usage past $1,000 a month ([Kortix pricing](https://kortix.com/pricing)); the tokens themselves go to whichever provider holds your key, at its published rates.

The configuration sits where the bill does, in the repo:

```yaml
agents:
  kortix:
    file: agents/kortix.md
    connectors: all
    secrets: all
    kortix_permissions: all
```

Source: `packages/starter/templates/base/kortix.yaml` in [Kortix on GitHub](https://github.com/kortix-ai/suna/blob/dev/packages/starter/templates/base/kortix.yaml), the manifest every new project starts from. An agent's reach is six lines of YAML and a markdown file, versioned with the rest of the company. Widen a grant and it is a diff a person reads. Run the same manifest on Kortix Cloud, in your VPC, or on your own on-prem network. Self-host is free.

## What to read next

The wider comparison, product against product, is in [the open-source ChatGPT Work alternative](/blog/open-source-chatgpt-work-alternative). If your shortlist also holds Microsoft's agent stack, [Microsoft Copilot pricing](/blog/microsoft-copilot-pricing) runs the same arithmetic over Copilot Studio credits.

Price the month before it starts: [Kortix](https://kortix.com) is free to start on managed cloud, and free to self-host.
