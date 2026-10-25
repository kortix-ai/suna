---
title: "Microsoft Copilot pricing: the credit meter, and the open-source alternative"
description: "Microsoft Copilot costs $30 a seat, but the Copilot Studio credit meter decides an agent team's bill; this is that arithmetic, and the open-source alternative."
date: "2026-10-19"
slug: "/microsoft-copilot-pricing"
canonical: "https://kortix.com/blog/microsoft-copilot-pricing"
author: "team"
tags: ["Field notes"]
---
Microsoft 365 Copilot lists at $30 per person per month, and that is the number every quote repeats ([Copilot Studio licensing guidance](https://www.microsoft.com/licensing/guidance/microsoft-copilot-studio)). For a team that builds agents, the seat is the entry fee. The bill is the Copilot Studio credit meter behind it: packs of 25,000 credits for $200 a month, or $0.01 a credit on a pay-as-you-go meter. Microsoft publishes both rates and leaves the multiplication to you, so here is the arithmetic, and what the same layer costs when it is open source and your team owns it.

## Three prices on one quote, and one that scales

Microsoft Copilot is sold as an add-on plan. It requires one of the listed Microsoft 365 subscriptions ([Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-365/copilot/microsoft-365-copilot-licensing)). That is the $30 line. From December 1, 2026, new Microsoft 365 Copilot and Copilot Business subscriptions can be bought without a qualifying base subscription. Microsoft says the price stays the same ([Partner Center, October 2026](https://learn.microsoft.com/en-us/partner-center/announcements/2026-october)).

Copilot Studio is priced on the tenant, separately from the seat. A pack holds 25,000 Copilot Credits for $200 a month (checked October 2026). It is billed annually, and unused credits do not roll over. The pay-as-you-go meter bills $0.01 a credit against an Azure subscription, with no upfront commitment ([Copilot Studio licensing guidance](https://www.microsoft.com/licensing/guidance/microsoft-copilot-studio), [product page](https://www.microsoft.com/en-us/copilot/products/copilot-studio)).

Seats scale with headcount: every person added carries the $30 rate. Credits scale with what the agents do, and headcount does not cap them. A seat quote can be accurate and still understate the rollout several times over.

## What a Copilot credit buys

A Copilot Credit is not a fixed unit of work. Microsoft defines it as a measure of "the time and effort" an agent needs to retrieve information, respond, and act ([licensing guidance](https://www.microsoft.com/licensing/guidance/microsoft-copilot-studio)). The rate changes with the feature that answers.

| Agent feature | Copilot Credits | With a Microsoft 365 Copilot license |
| --- | --- | --- |
| Classic answer | 1 | No charge |
| Generative answer | 2 | No charge |
| Agent action | 5 | No charge |
| Tenant graph grounding | 10 per message | No charge |
| Agent flow | 13 per 100 actions | No charge when the agent triggers it |

The rows stack. A tenant-graph grounded answer carries 10 credits for the grounding plus 2 for the generative answer. A reasoning model adds a token meter on top ([billing rates](https://learn.microsoft.com/en-us/microsoft-copilot-studio/requirements-messages-management)). Nothing in that table gives you a monthly figure. You need run volume and a feature mix first.

## A support agent, worked to a monthly bill

Microsoft's example is a website support agent. An average run is four classic answers and two generative answers, at 900 customers a day. Microsoft puts that traffic at 7,200 Copilot Credits a day ([billing rates](https://learn.microsoft.com/en-us/microsoft-copilot-studio/requirements-messages-management)).

A pack holds 25,000 credits, less than four days of that traffic. A 30-day month runs past the eighth pack, so the bill is the pack count times $200. The rest of the pack expires at month end.

The pay-as-you-go meter prices the same traffic at $0.01 a credit. A pack costs less per credit than the meter, so it is the default. Buy short and the agent stops at 125% of prepaid capacity. Buy long and the remainder expires.

Seats at $30 each are the line the buyer budgets. The monthly pack line is larger, and the seat quote leaves it out.

## Where the included allowance stops

The seat is not wasted on agent work. For people licensed with Microsoft 365 Copilot, classic answers, generative answers, and tenant graph grounding are zero-rated inside Copilot Chat, Teams, and SharePoint ([standard harness licensing](https://learn.microsoft.com/en-us/microsoft-copilot-studio/billing-licensing)). Fair usage limits apply. Agent flows count only when the agent triggers the run for a licensed person. Computer-using agents are outside the allowance.

Everything else lands on the meter. That includes customers on a public website, frontline staff without a license, scheduled runs, and flows with another trigger. Microsoft's second example shows the split. Fifty licensed people cost no credits. One hundred unlicensed people, each with four generative answers and four tenant-graph-grounded answers a day, cost 4,800 credits a day. That audience is metered daily, and one pack covers about five days.

The allowance has a hard edge. Microsoft enforces prepaid capacity at 125%, then disables the agent until capacity is raised or the month resets ([billing rates](https://learn.microsoft.com/en-us/microsoft-copilot-studio/requirements-messages-management)). A pay-as-you-go meter removes that cut-off. It also removes the last ceiling on the bill.

## What the layer costs when you own it

[Kortix](https://kortix.com) is the open-source AI Operating System we build. Agents, skills, company memory, and connectors are files in one git repo the team owns ([Kortix docs](https://kortix.com/docs)). Session work reaches `main` through a change request. Merge is default-deny for agents, so a person reads the diff before anything lands.

The bill is smaller and shaped differently. Credits pay for the cloud computer each session runs on. It bills per second and costs nothing while it is stopped. Paid plans start at $50 a month, and the pricing page puts a month of credits at about 1,830 agent-computer hours ([Kortix pricing](https://kortix.com/pricing)). Model calls go to your provider. Bring your own keys and the first $1,000 a month is free, then Kortix adds 5%, paid from credits. Run it on Kortix Cloud, in your VPC, or on your own on-prem network. Self-host is free.

Leaving has a price too, paid in rebuilds. A Copilot Studio agent moves as a Power Platform solution into another Microsoft environment. Microsoft's documentation says custom topics and knowledge sources might not come with it, and conversation, bot, and environment IDs do not transfer ([export and import](https://learn.microsoft.com/en-us/microsoft-copilot-studio/authoring-solutions-import-export)). A Kortix project is a git repo, so a clone brings the agents, skills, and memory with it.

Two costs move to your side of the ledger. The model bill and the infrastructure bill become yours, and so does the work of running them. An hour of session time costs an hour of computer time whether the agent answered one ticket or forty. Short, uniform, high-volume chat is a poor shape for it.

## The decision rule

- **Every person who touches the agent holds a Copilot license, and the agent lives in Teams, SharePoint, or Copilot Chat.** Buy the seats and stop. Usage inside those surfaces is zero-rated within fair usage limits. A second system is a second thing to govern.
- **The agent serves customers or unlicensed staff, and runs are short and uniform.** Do the multiplication: runs per month, times credits per run, divided by 25,000, rounded up, times $200. Compare that with the same credits at $0.01. Microsoft is likely cheaper here. Copilot Studio is also the low-code tool for the people who will maintain it.
- **Runs are long, variable, or file-heavy, and the rate changes with every feature the agent touches.** A forecast becomes a guess. The 125% cut-off turns a bad guess into an outage. Own the compute instead, where the meter counts seconds.

The dividing line is who the agent serves and how long it runs. The model behind it matters less than the shape of the work.

## Side by side

```compare
them: Microsoft Copilot
rows:
  - dimension: Open source
    them: "No, a closed product"
    kortix: "Yes, self-host or managed cloud"
    lean: kortix
  - dimension: Prerequisite
    them: "A Microsoft 365 plan, until December 1, 2026"
    kortix: "None"
    lean: kortix
  - dimension: Billed unit
    them: "Copilot Credits, per action"
    kortix: "Computer seconds, while a session runs"
    lean: both
  - dimension: Included agent use
    them: "Licensed people in Microsoft 365 surfaces"
    kortix: "None, every session is metered"
    lean: them
  - dimension: Model choice
    them: "The models Microsoft offers"
    kortix: "Any model, your keys"
    lean: kortix
  - dimension: Self-host
    them: "No, Microsoft's cloud only"
    kortix: "VPC or on-prem"
    lean: kortix
  - dimension: Idle cost
    them: "Monthly packs; unused credits expire"
    kortix: "Nothing while the computer is stopped"
    lean: kortix
  - dimension: Review before work lands
    them: "Pipelines and approval gates"
    kortix: "A change request a person merges"
    lean: both
```

The [open-source Microsoft Copilot map](/blog/open-source-microsoft-copilot-alternative) splits the Copilot line into lanes if you are still deciding which product you are replacing. [Kortix vs Copilot Studio](/blog/kortix-vs-copilot-studio) takes the tenant boundary in detail.

```cta
title: Price the layer you own
body: Free to start, free to self-host.
```

Start free on managed cloud, or self-host it free: [Kortix](https://kortix.com).
