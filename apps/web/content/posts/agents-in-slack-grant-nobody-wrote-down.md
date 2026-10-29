---
title: "Agents in Slack: what an open-source install leaves undecided"
description: "An open-source agent answers in a Slack thread in an afternoon. What it may touch without a person sits in a separate file most teams never review."
date: "2026-10-24"
slug: "/agents-in-slack-grant-nobody-wrote-down"
canonical: "https://kortix.com/blog/agents-in-slack-grant-nobody-wrote-down"
author: "team"
tags: ["Field notes"]
---
You can have an agent answering in a Slack thread by the end of the afternoon: connect the workspace, invite the bot, link an account, mention it with a task. Then a colleague asks what else it can reach while nobody is watching, and nobody wrote that down. Kortix is the open-source AI Operating System: your agents, their skills, your company memory, and every connector in one git repo you own, with the agents working on real cloud computers.

The install settles which messages reach the agent. A second file settles what the agent may do once one arrives.

## What Slack hands you

What can Slack agents do? Slack's product page answers with the mention: you "@mention an agent just like any other member of the team", in channels, DMs and threads, and it suggests and takes action in the flow of work ([Slack](https://slack.com/ai-agents)). The developer guide adds the mechanics: Slack is conversational by default, context-aware, built on Block Kit, with built-in identity and permissions ([agent guide](https://docs.slack.dev/ai/agents)).

Slackbot is the built-in case: a personal agent inside Slack, drafting in your voice, reading uploaded files and answering from your messages, seeing only what you can see ([Slack](https://slack.com/blog/news/slackbot-context-aware-ai-agent-for-work)). Third-party assistants arrive as apps, internal or listed in the Marketplace, as Slack's guide describes.

Can I use ChatGPT agents in Slack? Yes. OpenAI ships a ChatGPT Agents app that deploys a workspace agent into Slack channels, where it answers questions, runs tasks through connected systems and posts files back ([OpenAI](https://help.openai.com/en/articles/20001199-chatgpt-agents-app-in-slack)). It needs a paid Slack plan, a Business, Edu or Enterprise ChatGPT account, and often a Slack admin's approval.

What are the key differences between the Slack app and the Slack agent? The app is the installable package: a manifest, a bot token, a signing secret and the permissions the workspace grants that bot. The agent is the loop behind it, which Slack describes as autonomous within defined boundaries, goal-oriented and able to use tools. One decides whether a message arrives. The other decides what happens next.

Slack's docs do not pretend the second half is solved. Agents "are not inherently safe", an action with real-world output should require explicit human confirmation, and guardrails and human-in-the-loop checkpoints are "engineering requirements" ([agent guide](https://docs.slack.dev/ai/agents)). Fair division: the surface is Slack's, and what runs behind it belongs to whoever installs it.

## Four moves to a bot in the channel

How do I add an agent to Slack? In a Kortix project it takes four moves. Connect the workspace with `kortix channels connect` and open the link it prints. Invite the bot to a channel. Send `/kortix login` once, since a Slack message carries no Kortix credential. Mention the bot with the task ([channels docs](https://kortix.com/docs/connect/channels)).

```bash
kortix channels connect     # Slack; add --platform teams for Microsoft Teams
kortix channels manifest    # a host without the shared app prints its manifest
```

The second line is the fallback for a host with no shared Slack app: print the manifest, create the app at api.slack.com/apps, install it, connect with `--bot-token xoxb-… --signing-secret …`.

One Slack thread is one session, so later messages continue it after the machine stops and resumes. In a channel only a mention reaches the session; a reply without one stays between people. A direct message is private to the person who sent it.

An afternoon gives you a working bot with your company's tools behind it. Nothing in those four moves says which tools it may call.

## What the install leaves open

The starter project is the easy case: nobody edited its `agents:` block. In `kortix.yaml` that map is governance only: connectors, secrets, Kortix permissions, skills, the workspace boundary and the enabled flag, plus `file`. Grants are deny-by-default: an omitted `connectors`, `secrets` or `kortix_permissions` resolves to none, while an omitted `skills` grant leaves `permission.skill` in the agent's `.md` in charge ([manifest reference](https://kortix.com/docs/project/manifest)). The front-door agent ships with everything open ([`kortix.yaml`](https://github.com/kortix-ai/suna/blob/dev/packages/starter/templates/base/kortix.yaml)):

```yaml
agents:
  kortix:                     # what the starter writes
    file: agents/kortix.md
    connectors: all
    secrets: all
    kortix_permissions: all
    skills: all
    workspace: { project_repository: true }

  slack-desk:                 # the same project, scoped to one job
    file: agents/slack-desk.md
    connectors: [linear, github]
    skills: [triage]
    workspace: { project_repository: true }
```

The second block is the argument. `slack-desk` reaches two connectors and one skill, and holds no secrets and no project permissions, because those lines were deleted and deletion grants none. It can still answer where it was asked: the channel that started a session is always callable from it ([connectors](https://kortix.com/docs/connect/connectors)).

Grants decide reach. Policies decide what happens on a single call. A connector's `policies:` list matches tool names, and the documented example lets every `get_*` action run while everything else waits for approval. Actions are `always_run`, `require_approval`, `block`, shown as Allow, Ask, Block. Approval holds the call; the agent's turn pauses and resumes. From a terminal, `kortix connectors policy gmail set send_email block` blocks one action.

Rules and the default answer different questions. Project-wide `policies:` are checked before the connector's own list, and the first matching rule wins. `policy.default_mode` decides only the calls no rule matched: it falls back to `allow_all`, so an unmatched call runs, and the other value, `risk`, runs reads while holding writes and destructive calls for a person ([manifest reference](https://kortix.com/docs/project/manifest)). A fresh project with a bot in a busy channel has a specific shape: every connector the grant names, every action allowed, nobody on the hook for the call that should have waited. A held call expires after 24 hours by default, and the session does not resume.

## One run, from mention to merge

A mention in `#support` starts a session. Each session has its own isolated machine and branch. The agent clones the repo, cuts a branch and reaches for a tool.

If a policy asks for approval on that action, the call stops and a card lands in the thread with the action, the parameters the connector will receive and the agent's description of the effect, marked as not verified. A project manager, or the person who started the session, picks Approve or Deny ([channels docs](https://kortix.com/docs/connect/channels)). The token stays out of the agent's hands either way: connector credentials are brokered server-side and never enter the machine.

One decision covers one exact call, with the same connector, action, arguments and account; a changed argument needs a new one. An identical repeat inside 15 minutes runs once ([connectors](https://kortix.com/docs/connect/connectors)).

The work ends the way session work ends: the agent commits, pushes its branch and opens a change request. A change card in the thread offers Ship it or Reject, and a comment travels back to the agent. Session work reaches `main` through a change request. Merge is default-deny for agents, so the person holding `project.gitops.merge` lands it.

The card is product behavior. The rule that produces it is a line a team writes, and a project that never writes one gets the run without the pause.

## Where a hosted teammate is less work

Hosted products absorb some of this labor. A managed Slack connection needs the Slack app credentials on the server; a self-hosted instance without them falls back to the paste-your-manifest route, and needs credentials for each channel it offers. Every person links an account before a first mention, and someone holds the approver role during working hours.

If nobody wants to own a repo, a manifest and a review queue, a hosted teammate is the better purchase. It costs you the diff and the self-host, and carries the operational weight.

## Who this fits

An agent in Slack fits a team that already reviews changes and has someone who can hold a grant review. The install is an afternoon. The grant is a decision about which two or three connectors this job needs, which actions may run unattended, and who decides the rest. Write that in the repo before the channel fills up.

[Open-source agent tool access starts at the credential boundary](/blog/secure-ai-agent-tool-access) covers scoped connectors and approval policy. [Kortix vs QM](/blog/kortix-vs-qm) compares two open-source designs that both open in Slack, and [where the review gate sits in open-source agent systems](/blog/open-source-ai-agent-platform) is the one to send a security reviewer.

Kortix is free to start and free to self-host. [Try Kortix](https://kortix.com).
