---
title: "Kortix vs OpenWork: open source, and the record a team reviews"
description: "OpenWork suits one person at one machine, while open-source Kortix keeps an agent's work as a diff a teammate approves and merges."
date: "2026-09-26"
canonical: "https://kortix.com/blog/kortix-vs-openwork"
author: "team"
tags: ["Comparisons"]
updated: "2026-10-22"
slug: "/kortix-vs-openwork"
---
OpenWork is the right open-source desktop agent for one person at one machine; Kortix is the open-source AI Operating System, one git repo holding your agents, their skills, your company memory and every connector, with the agents working on real cloud computers. OpenWork keeps the session on the laptop where it started, which is the whole answer until a colleague has to approve the result. An approval needs a record, and a desktop app has nowhere to keep one a second person can read.

```logos
label: 'Compared here:'
items:
  - { name: OpenWork, domain: openworklabs.com }
```

## What OpenWork does better than we do

For a single operator these are real advantages, and they settle the choice for a lot of people.

- **No account, no server.** The app runs on macOS, Windows, and Linux, and using it locally needs no OpenWork account ([OpenWork on GitHub](https://github.com/different-ai/openwork), checked October 2026).
- **Files stay on the machine.** In desktop mode the work happens on local files and prompts go to the provider you chose, while cloud workers are optional and priced separately ([openworklabs.com](https://openworklabs.com), checked October 2026).
- **Any model, including a local one.** 50+ providers, your own API keys, a ChatGPT sign-in, or Ollama ([README](https://github.com/different-ai/openwork)).
- **Skills that travel between tools.** One OpenWork MCP puts the team's skills and connections inside Codex, Claude Code, or Cursor ([README](https://github.com/different-ai/openwork)).
- **An MIT core.** Everything outside the `ee/` directory is MIT and free for any use, and each `ee/` release converts to MIT two years after publication ([README, licensing](https://github.com/different-ai/openwork#licensing)).

## A second person turns a tool into a system

On your own, the desktop app is the whole answer. Files sit where they always sat, the model is the one you picked, and there is nothing to deploy. The questions change when someone else has to sign off on the result.

What did the agent change, what could it reach when it changed it, and who said yes? OpenWork's paid control plane answers part of that. Roles come with OpenWork Cloud and Den, SSO arrives on the Team plan, and SCIM provisioning, desktop policies, version controls and the audit log arrive with Enterprise ([OpenWork pricing](https://openworklabs.com/pricing), checked October 2026). Those govern who may use which model, which app version runs, and what a member can open.

None of them holds the output. The agent's work still lands in a folder on a member's machine, and a folder is something one person owns. OpenWork will rent that member a cloud computer for $50 a month, which moves the machine without changing the unit: one computer per member, holding that member's files ([OpenWork pricing](https://openworklabs.com/pricing)). A second reviewer has nothing to open that the first person did not already have open.

That gap does not close with a release, because review needs two versions of the same thing and a place where both people can see them.

## The record is a branch, and the branch outlives the session

The starter project's own agent file puts the difference plainly. The path is `packages/starter/templates/base/agents/kortix.md` in [Kortix on GitHub](https://github.com/kortix-ai/suna/blob/dev/packages/starter/templates/base/agents/kortix.md) (checked October 2026). It tells the agent that the session is "an ephemeral branch of this repo", and that "Only what you commit + push survives".

The file addresses the agent directly, and it treats the branch, not the conversation, as the thing that lasts. A session that runs six hours and edits forty files leaves a diff against `main` and nothing else. When the sandbox is gone, that diff is what a colleague opens. Approval attaches to the same object the work lives in, which is why the gate is a merge and not a message. Session work reaches `main` through a [change request](/docs/git). Merge is default-deny for agents.

The agent gets reviewed the same way. In a project an agent is `agents/<name>.md` plus an `agents.<name>` block in `kortix.yaml`, so a change to how that agent behaves travels in the same change request as the work it did. A team that decides an agent should stop touching billing lands the decision as a diff somebody approved, and can read it again six months later. Kortix is open source. Read it, fork it, audit it.

The review only works because each session gets its own machine. Each session has its own isolated machine and branch. Forty sessions on one repo never argue over a working copy, and a failed experiment cannot touch the branch that produces the release.

## Where OpenWork still wins

One reader gets a straight recommendation: one person, one machine, no server, and no second reviewer. OpenWork is free, the core is MIT, and the download is the install, so for that reader the choice is settled.

## Every row comes back to the record

```compare
them: OpenWork
rows:
  - dimension: Open source
    them: MIT app and core; Den under the EE License
    kortix: Yes, self-host or managed cloud
    lean: both
  - dimension: Where the agent runs
    them: Your machine, or a cloud computer per member
    kortix: Its own sandbox per session
    lean: them
  - dimension: What holds the record
    them: The member's own workspace
    kortix: A branch of the repo you own
  - dimension: How work lands
    them: Direct edits to local files
    kortix: A change request a person approves
  - dimension: Team controls
    them: Roles on Cloud; SSO on Team; SCIM, desktop policies, audit on Enterprise
    kortix: Permissions per resource, roles, audit trail
    lean: kortix
  - dimension: Self-host
    them: Free to 5 people, then a subscription
    kortix: Free
    lean: both
  - dimension: Price
    them: $10 per seat a month after 5 free
    kortix: Free tier, then credits from $50; members free
    lean: them
```

## One bill counts people, the other counts machines

The two bills charge for different units. Kortix charges for the machine: free is $0 with 500 credits a month, every feature and one project, on your own provider keys or a ChatGPT subscription. The rate is 100 credits per dollar, so 5,000 credits a month costs $50 ([Kortix pricing](https://kortix.com/pricing), checked October 2026). Members are unlimited and free, and the account shares one credit pool. OpenWork charges per person once a team passes five: the control plane self-hosts free to five people, the first five Cloud seats cost nothing, and the Team plan is $10 per seat per month with SSO. Enterprise is custom-priced and adds SCIM, desktop policies, version controls and the audit log ([OpenWork pricing](https://openworklabs.com/pricing), checked October 2026). Adding a sixth reviewer moves that bill and does nothing to the credits.

```verdict
themLabel: OpenWork
them: you want a free agent on your own files, you are the only reviewer, and a server would be overhead.
kortix: a second person has to approve the work, and you want that approval attached to a diff in a repo the company owns.
```

If the question is really about a coding agent on a laptop, [Kortix vs OpenHands](/blog/kortix-vs-openhands) covers the harness end of it. The same argument about personal agents runs through [personal AI agents vs a company OS](/blog/personal-ai-agents-vs-company-os), and [six self-hosted AI workspaces](/blog/best-self-hosted-ai-workspace) applies it to the install itself.

```cta
title: Give the work a record a teammate can approve.
body: Free to start, free to self-host.
```
