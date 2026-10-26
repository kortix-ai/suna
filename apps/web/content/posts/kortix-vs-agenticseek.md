---
title: "Kortix vs AgenticSeek: open source that outlives one laptop"
description: "Kortix is the open-source AI Operating System a team reviews, while AgenticSeek runs a private agent on one laptop."
date: "2026-10-15"
canonical: "https://kortix.com/blog/kortix-vs-agenticseek"
author: "team"
tags: ["Comparisons"]
updated: "2026-10-22"
slug: "/kortix-vs-agenticseek"
---
AgenticSeek gives one person a capable private agent on hardware they already own, while Kortix is the open-source AI Operating System for the team that has to review the result. Both put an agent to work on real files. The output lands in different places: a folder on one laptop, or a branch a colleague can open. Which of those does your team need?

```logos
label: 'Compared here:'
items:
  - { name: AgenticSeek, domain: github.com }
```

## What AgenticSeek gets right

The project calls itself a 100% local alternative to Manus AI. The description holds up. It browses, reads pages and fills forms, writes and runs code in Python, C, Go and Java, and splits a long task into steps ([AgenticSeek on GitHub](https://github.com/Fosowl/agenticSeek)). The code is GPL-3.0, so you can read it, run it and change it, and a version you redistribute keeps the same terms ([licence](https://github.com/Fosowl/agenticSeek/blob/main/LICENSE)). Speech to text, the model and speech output can all run locally. A search, a file and a conversation stay on the device.

Setup is a clone, an `.env` file and Docker for the bundled search service. A `config.ini` names the provider and model. Point it at Ollama, LM Studio or a local OpenAI-compatible server, and the model calls add nothing to a bill. The trade: Docker, a Python environment and a model server have to keep working.

- **It publishes its limits.** The FAQ puts a 14B model at 12 GB of VRAM and calls it usable for simple tasks, with 70B or more recommended for advanced work.
- **The browser does real work.** It drives a Selenium Chrome session, `stealth_mode` makes the automation harder to detect, and form filling is a listed browsing feature. The voice assistant is still marked in progress.
- **Nobody is selling you anything.** The README says the project has zero roadmap and zero funding, and that its author built it with two friends.

## One operator, one config file

For one person the design is coherent. Provider, model, working directory and browser behavior live in a single file on a single machine. The agent reads and writes inside `WORK_DIR`. The README tells you to choose that folder carefully, because the agent can reach everything in it.

The security model is documented in the README. Read it before a second person joins. The backend binds to localhost by default and requires a token. Under Docker, the agent's commands run as an unprivileged user with provider keys removed from the environment. `safe_mode` is described as "a best-effort command filter, not a sandbox" ([AgenticSeek on GitHub](https://github.com/Fosowl/agenticSeek)). Agent code can still read and write everything in `WORK_DIR` and reach the network. A separate setting copies your browser logins, cookies and saved passwords into the agent's browser. The README flags that as handing the agent your authenticated sessions.

None of that is a defect in a personal tool. The person at the keyboard is the reviewer, owns the files and holds the only account that matters, and a second person breaks all three.

## A session is a branch somebody else can open

In Kortix, the agent does not work in a folder on your laptop. Each session gets a clone of the project repo on its own branch and its own cloud computer. The [starter agent file](https://github.com/kortix-ai/suna/blob/dev/packages/starter/templates/base/agents/kortix.md) states the consequence in one line: "Only what you commit + push survives." The installs, the experiments and the half-finished scripts disappear with the session.

A branch has a parent, a diff and a name. A teammate can fetch it and run it without asking for your laptop or your GPU. When the work is ready, the agent commits and opens a change request. Session work reaches `main` through a change request, and merge is default-deny for agents. A team that wants an agent to merge its own change adds `project.gitops.merge` to that agent's grant ([Kortix docs](https://kortix.com/docs)). The change request carries the diff and the branch name, so review happens where the code lives. The branch is named after the session, so a run and its diff stay linked in the repo.

## Grants live in the repo

The other file is the project manifest. Here is the starter agent's block:

```yaml
agents:
  kortix:
    file: agents/kortix.md
    connectors: all
    secrets: all
    kortix_permissions: all
    skills: all
```

The comment above it explains the default: the file is deny-by-default, and an omitted connectors, secrets, kortix_permissions or skills grant resolves to none, "so a scoped specialist starts locked down" ([starter manifest](https://github.com/kortix-ai/suna/blob/dev/packages/starter/templates/base/kortix.yaml)). The starter agent is granted everything on purpose, so a new project is capable on day one. Every grant you remove is a line in a diff somebody reviews, so narrowing an agent is a code change with a reviewer.

## What a team pays for

Pricing follows the same shape: you pay for the computer the agent uses, and members are not seats. Free is $0 with 500 credits per month and 1 project, on your own provider keys or a connected ChatGPT subscription. The paid plan starts at $50 a month. Credits run at 1 credit = $0.01, and 11 credits = 1 hour of agent computer. A stopped agent computer costs nothing. Members are unlimited and free, and the account shares one credit pool. Unused monthly credits roll over one month ([Kortix pricing](https://kortix.com/pricing), checked October 2026). Managed models run on credits and need the paid plan. Run Kortix on Kortix Cloud, in your VPC, or on your own on-prem network. Self-host is free when the repo has to stay inside your network.

## Where AgenticSeek wins

Some work should never leave the machine. A model on your own GPU, a search index on your own disk and no account anywhere is a stronger guarantee than a hosted product can make. The bill is electricity. For one operator, one laptop and one folder of sensitive files, AgenticSeek is the better tool; a review queue would only add a step. It keeps working on a plane, in a lab with no outbound network, or on a machine where nobody may create a cloud account.

## Side by side

| Dimension | Kortix | AgenticSeek |
| --- | --- | --- |
| Open source | Yes, self-host or managed cloud | Yes, GPL-3.0 |
| Built for | Teams sharing one project | One person on one machine |
| Where setup lives | The project repo, versioned | A local `config.ini` |
| Where it runs | Cloud, your VPC, or on-prem | Your own machine |
| Review of work | A change request before merge | Writes into your directory |
| Isolation | One sandbox per session | One `WORK_DIR`; tasks share your machine |
| Price shape | Free $0, credits from $50 a month | Hardware and power only |

## How to choose

If one person does the work and keeps the files, install AgenticSeek and give it a good GPU. Read its security section first. Point `WORK_DIR` at the folder you mean to share with it, and leave the browser profile import off unless the agent genuinely needs your logged-in sessions.

Two people need to see the work, question it and keep it. That takes a home both of them can reach, and output that survives the session. Kortix is built for that case. Agents, skills, memory and connectors live in one repo, each session gets its own machine and branch, and a change request sits between the agent and `main`.

For the same question against a hosted agent, read [Kortix vs Manus](/blog/kortix-vs-manus). For the wider field of local tools, read [personal agents versus a company system](/blog/personal-ai-agents-vs-company-os).

```cta
title: Give the work somewhere to land.
body: Free to start, free to self-host, and the first agent can run on your own keys.
```
