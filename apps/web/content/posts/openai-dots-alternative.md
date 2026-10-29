---
title: "OpenAI dots alternative: the open-source answer keeps the rules, not the clone"
description: "OpenAI dots run on OpenAI's model and cloud, while open-source Kortix keeps the agent's rules, grants and review in a repo your team owns."
date: "2026-10-21"
slug: "/openai-dots-alternative"
canonical: "https://kortix.com/blog/openai-dots-alternative"
author: "team"
tags: ["Comparisons"]
---
OpenAI's dots are a serious piece of work, a named assistant with its own cloud computer that keeps working after you close the chat; Kortix is the open-source AI Operating System: your agents, their skills, your company memory, and every connector in one git repo you own, with the agents working on real cloud computers. It is the alternative a team keeps once a plan lapses. The question that decides it is where the rules that bound the agent live, and who can read them.

```logos
label: 'Compared here:'
items:
  - { name: OpenAI dots, domain: openai.com }
  - { name: OpenDots, domain: copilotkit.ai }
```

## A dot is an assistant with a computer, on OpenAI's terms

A dot is an always-on agent that lives in ChatGPT and holds a steady goal. It keeps working between conversations. OpenAI shipped it on 2026-09-29 on GPT-6 Astra, with its own cloud computer, its own browser, and the apps you connect ([OpenAI](https://openai.com/index/introducing-dots)). You can message it in ChatGPT on desktop, web and mobile, in Slack and in Teams, and you can call it.

- **It works while you are gone.** Dots keep several tasks moving at once; the launch post shows one turning customer feedback into built and tested fixes, with a video attached ([OpenAI](https://openai.com/index/introducing-dots)).
- **It reaches 4,000+ apps.** Plugins connect it to the tools a team already pays for ([OpenAI](https://openai.com/index/introducing-dots)).
- **The controls are real.** Custom Rules allow an action, require approval, or block it, and background research is read-only ([OpenAI](https://openai.com/index/introducing-dots)).
- **Entry costs a plan you may already hold.** Your first dot comes with Pro or Business Premium at no extra cost ([OpenAI](https://openai.com/index/introducing-dots)).

For one person with a ChatGPT subscription and a backlog, that is a good afternoon saved.

## The plan is the gate, and the owner is one person

The workspace documentation makes the shape clear. A dot belongs to one person, and only that person can direct it: other people's mentions do not start work for it ([workspace controls](https://help.openai.com/en/articles/20001554)). Rollout narrows it further. On Pro, dots are available outside the European Economic Area, Switzerland and the UK, and Enterprise access stays off until an admin enables it ([getting started](https://help.openai.com/en/articles/20001530)).

Two details matter more than geography. Enterprise model settings do not apply to dots, so a company's model policy says nothing about what its dots run on ([workspace controls](https://help.openai.com/en/articles/20001554)). And a dot's memory is not something you can curate. You cannot view, delete or edit a single memory it holds; deleting the dot is the only lever ([privacy and safety](https://help.openai.com/en/articles/20001529)). OpenAI's people may review activity in limited safety cases even with model improvement switched off ([privacy and safety](https://help.openai.com/en/articles/20001529)).

None of that is a flaw in a personal assistant. It is what a personal assistant is: one owner, and one vendor's judgment about what that owner may do. A team answering a security questionnaire asks something else. Where is the rule written, who approved it, and what would a reviewer read in six months?

## A clone hands you a template to keep running

The open-source projects closest to dots are honest about being starting points. CopilotKit's OpenDots is the nearest copy of the design: a named specialist per job with its own instructions and permitted tools, plus browser, file and shell permissions set per Dot. It is MIT-licensed, on web and mobile ([OpenDots](https://github.com/CopilotKit/OpenDots)). Approval cards pause a tool call for a person; read-only tools go ahead. As a copy of the experience, nothing here is closer.

Its repository says what it is in one line: "A template, not a hosted product", in early development, with one owner identified by a stable `OWNER_ID` ([OpenDots](https://github.com/CopilotKit/OpenDots)). Conversations need CopilotKit Intelligence: the hosted service, a local Docker evaluation, or a licensed self-hosted deployment. Someone on your team now owns that stack and its upgrades.

Anil-matcha/open-dots takes another shortcut. It wraps the Claude Code CLI and runs tasks from Telegram or a browser, with conversations in Postgres. File writes, shell commands and pushes wait for approval ([open-dots](https://github.com/Anil-matcha/open-dots)). It supports Claude only, has no multi-agent features, and its README says it is not a feature-for-feature replacement. Its description calls it MIT-licensed.

Both answer one question: how a small team runs something like dots on its own hardware. Neither answers what a second person asks on Monday: may this agent send that email, and who said so?

## Open source has to mean a repo, not a download

What a team keeps is the file that says what the agent may touch. In Kortix that file is `kortix.yaml` at the root of a project repository, and the starter template ships it deny-by-default:

```yaml
# v2 is deny-by-default: an omitted connectors/secrets/kortix_permissions/
# skills grant resolves to "none", so a scoped specialist starts locked down.
agents:
  kortix:
    file: agents/kortix.md
    connectors: all
    secrets: all
    kortix_permissions: all
    skills: all
```

The exception sits in the same file: the starter agent is granted everything so a fresh project works out of the box, and the comment says to narrow that once you know what the project needs. That is the first task on a new project, and it is a diff a colleague reads ([Kortix on GitHub](https://github.com/kortix-ai/suna), [agents and permissions](https://kortix.com/docs/project/agents)).

An agent's behavior sits next to its grant, in `agents/<name>.md`. The starter file spells out what a session is:

> The session you're in is an isolated sandbox ... an ephemeral branch of this repo, your own `/workspace` ... Only what you commit + push survives.

One isolated sandbox per session. Each session has its own isolated machine and branch. A Kortix session's work is a branch that disappears unless someone commits it, and a branch is something a team already reviews. A dot's work lives in OpenAI's account, and the files and threads it creates outlive the dot.

## The gate is a file, and it runs in a live repo

Merge is where an agent's work becomes the company's. In Kortix it is a permission. Session work reaches `main` through a change request. Merge is default-deny for agents. A person with `project.gitops.merge` reads the change request and merges it, and a session merges its own only when its agent's grant lists that permission ([change requests](https://kortix.com/docs/git)). Give the agent a list without it and a person merges.

Kortix runs its own repository on that gate: between 2026-09-21 and 2026-10-21, two in five of the commits that landed on the default branch of [Kortix on GitHub](https://github.com/kortix-ai/suna) were authored by the agent itself, each one through the same change request a person could read. The rest came from people and two bots. The count is reproducible from the clone:

```bash
git clone --bare --filter=tree:0 --single-branch --branch dev \
  https://github.com/kortix-ai/suna /tmp/kortix.git
git -C /tmp/kortix.git log dev --first-parent \
  --since=2026-09-21 --until=2026-10-22 --format=%an > authors.txt
wc -l < authors.txt
# 2545
grep -c '^Kortix Agent$' authors.txt
# 1040
```

An agent landing a large share of a repository's commits through reviewed change requests is exercising the same gate a person does. What that buys is the resolution of the record: which agent, which grant, which diff, who merged. Any model provider with your own keys. Or the ChatGPT plan you already pay for. Swap the model and the rules that bound it stay put.

## Side by side

```compare
them: OpenAI dots
rows:
  - dimension: Open source
    them: 'No'
    kortix: Yes, self-host or managed cloud
    lean: kortix
  - dimension: Time to a first agent
    them: Minutes, inside ChatGPT
    kortix: An install, a repo, a first session
    lean: them
  - dimension: Apps and reach
    them: 4,000+ apps through plugins
    kortix: Connectors, plus any MCP server
    lean: them
  - dimension: Where it runs
    them: OpenAI's cloud only
    kortix: Kortix Cloud, your VPC, or on-prem
    lean: kortix
  - dimension: Where the rules live
    them: ChatGPT settings and Custom Rules
    kortix: One git repo, reviewed as a diff
    lean: kortix
  - dimension: Models
    them: GPT-6 Astra
    kortix: Any provider, your keys
    lean: kortix
  - dimension: Who merges the work
    them: Not published; PRs arrive for review
    kortix: A person, unless project.gitops.merge is granted
    lean: kortix
  - dimension: What a reviewer reads
    them: Activity View and task history
    kortix: The change request and its grant
    lean: kortix
  - dimension: Getting one
    them: Pro or Business Premium, eligible markets
    kortix: Free to start, free to self-host
    lean: kortix
```

## When to pick which

```verdict
themLabel: OpenAI dots
them: You are in an eligible market on a Pro or Business Premium plan and want one agent working for you this afternoon.
kortix: You need the agent's rules, access and record to belong to the company and survive a plan change.
```

There is a real case for a dot, and it is the common one. If one person wants an assistant already in their chat apps, on a subscription they hold, dots does that today with less setup than anything here. OpenDots gets closer to the interface itself, for a developer willing to run the services behind it. Its own README calls it a starting point, and that is fair.

The decision turns on a second person. Once someone else approves what the agent sends, grants a connector, or explains it to an auditor, the question stops being which agent is smarter. It becomes where the record lives. At OpenAI that record is Activity View inside one owner's account. In Kortix it is a change request against a repository the company owns.

More from the blog: [the open-source Lindy alternative](/blog/open-source-lindy-alternative) covers the same rent-or-own decision, [Kortix vs OpenClaw](/blog/kortix-vs-openclaw) goes deeper on review gates, and [GPT-6 Astra for agent teams](/blog/gpt-6-astra-for-agent-teams) is the model underneath a dot.

```cta
title: Get started with Kortix
body: Free to start, free to self-host.
```
