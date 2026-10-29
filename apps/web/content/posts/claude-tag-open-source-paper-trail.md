---
title: "Claude Tag adds a teammate. Open source adds a paper trail."
description: "Claude Tag gives Slack a capable teammate, while Kortix, the open-source AI Operating System, keeps agent grants in a git file a colleague can review."
date: "2026-10-23"
canonical: "https://kortix.com/blog/claude-tag-open-source-paper-trail"
author: "team"
tags: ["Comparisons"]
updated: "2026-10-25"
slug: "/claude-tag-open-source-paper-trail"
---
Claude Tag puts a capable teammate inside Slack, and Kortix is the open-source AI Operating System: your agents, their skills, your company memory, and every connector in one git repo you own, with the agents working on real cloud computers. A pilot can still end with a busy Slack channel and nothing a second person can approve before the next run. Putting a capable agent in a channel is now the cheap part of the purchase, whoever sells it. The expensive part is the record of what that agent was allowed to do, and that is the part worth choosing on.

## A capable teammate, one console away

Claude Tag is Anthropic's Slack teammate. Mention @Claude in a channel and it breaks the task into stages. It works through them, then answers in the thread with what it produced. Anthropic launched the product in beta on June 23, 2026, for Team and Enterprise plans. It says 65% of its own product team's code is now created by an internal version of Claude Tag ([Anthropic](https://www.anthropic.com/news/introducing-claude-tag)). That number is a vendor's own, so treat it as the size of the claim rather than the size of your result.

Three surfaces come with the product: channel mentions, direct messages, and a panel in Slack's AI assistant header. In a channel, one Claude serves everyone, so a second person can pick up a thread the first one started. Claude keeps channel memory instead of discarding it after each task, and it can follow up on a thread that has gone quiet ([Anthropic's help article](https://support.claude.com/en/articles/15594475-what-is-claude-tag)). Claude in Slack switched over to this experience on August 3, 2026. A Primary Owner or Owner opts the organization in to the move.

Anthropic's docs still describe the earlier Claude Code in Slack for workspaces that no organization has connected to Claude Tag. There, each session runs under one person's account and answers only Pro and Max mentions ([Claude Code docs](https://code.claude.com/docs/en/slack)). Two kinds of accountability sit behind the same @Claude handle. Know which one your workspace has.

## What the pilot hands over

Setup is an app install plus a set of console decisions. A Primary Owner or Owner provisions Claude's identity, connects the organization's tools and repositories, and chooses the channels it may work in. Anthropic states plainly that the Admin role cannot do this. Access is then granted at three levels, each inheriting from the previous level. Organization-wide credentials and repositories come first, then workspace access for every public channel, then extra credentials on a private channel ([the access model](https://support.claude.com/en/articles/15594475-what-is-claude-tag)).

Channel memory is retained on Anthropic's side, and admins review or delete it there. Spend is consumption-based, with a hard organization cap, per-channel limits, and alerts at 75% and 95% of any limit. Owners get an activity page. It lists scheduled and one-time tasks, plus every network call made under the organization's identity. Commits and pull requests from channel work carry the Claude GitHub App as their author. Each links back to the thread that started it.

That inventory looks different when an auditor asks for it six months later. What the company holds is a thread, a log, and a set of console settings. The identity that did the work stays with the vendor. So do the memory it accumulated and the settings that said what it could touch. A log answers what happened. It does not record what the agent was allowed to do in a form a second person can approve before the next run.

An open-source alternative already exists for the surface. open-tag rebuilds the Slack-style workspace with channels, threads and task claims for Claude Code, Codex and Copilot ([open-tag on GitHub](https://github.com/fancyboi999/open-tag)). The harder layer to replace is the one under it: what the agent may touch, where that is written, and who approves a change to it.

## The agent is a file a colleague can read

Kortix keeps the same decisions as files in the project's git repo. The header of the starter manifest marks the `agents:` map "GOVERNANCE ONLY": it carries the connectors, secrets, Kortix permissions and skills grants, the workspace settings and the enabled flag, plus the `file` field that names the agent's `.md`. Everything about how the agent behaves, from its description and model to temperature and prompt, sits in that file's frontmatter and body ([kortix.yaml](https://github.com/kortix-ai/suna/blob/dev/packages/starter/templates/base/kortix.yaml)). The starter's front-door agent is granted all four in seven lines:

```yaml
agents:
  kortix:
    file: agents/kortix.md
    connectors: all
    secrets: all
    kortix_permissions: all
    skills: all
```

Anything narrower is denied by default. The manifest calls v2 "deny-by-default": an omitted grant resolves to none, so a scoped specialist starts locked down. A legal agent and an engineering agent can hold different grants in the same file, and the difference between the two fits on one screen.

The agent's own file states where its authority comes from. Its frontmatter description reads, in part, "Its access is what kortix.yaml grants it." Its body tells the agent that "the session you're in is an isolated sandbox", and that the sandbox is "an ephemeral branch of this repo". A session that goes wrong leaves a branch instead of a broken production system, and its output arrives as a change you can read ([agents/kortix.md](https://github.com/kortix-ai/suna/blob/dev/packages/starter/templates/base/agents/kortix.md)).

A change to a grant is a diff on a file, so it can be reviewed like any other change. That is the property a console page cannot offer: the file, its history, and the name of the person who approved the last edit to it. When a contract ends, you still have all three.

## A review card, not a conversation

None of this asks people to leave Slack. Slack, Microsoft Teams and email are live. One Slack thread is one session, so the context of a request stays where the request was made. When that session files a review item, a card appears in the thread with a title, a summary and a risk note. An approval gets Approve, Deny and request changes. A change gets Ship it, Reject and request changes. The same items sit on the Review page in Kortix, and a Stop button on the live message ends the run at the runtime rather than hiding it from the thread ([channels docs](https://kortix.com/docs/connect/channels)).

Two settings decide how much of that is voluntary. Approval gates are a policy you choose, and the manifest leaves them open until you change it, since `policy.default_mode` starts at `allow_all` ([manifest reference](https://kortix.com/docs/project/manifest)). Session work reaches `main` through a change request, and merge is default-deny for agents ([Git and change requests](https://kortix.com/docs/git)). The agent proposes and a person merges. The Slack card is that decision, not a chat message about it.

Where the agent runs is a separate decision, and it does not have to be Anthropic's answer or ours. "Run it on Kortix Cloud, in your VPC, or on your own on-prem network." The same manifest that carries a pilot in a channel also runs on a self-hosted install inside your own network ([hosting docs](https://kortix.com/docs)). That is a different conversation at renewal.

## Two readers, two next moves

If you are on Team or Enterprise and weighing Claude Tag, run the pilot in one channel. Then ask for three artifacts: the file that defines the agent, the diff of the last change to its access, and the person who approved that change. If the answer is a console page and a thread, you have found the renewal conversation early. Better to price it now than after a year of channel memory.

If you already run an open-source agent, a Slack surface on top is a channel adapter, and a good one earns its place. The adapter does not put the agent's grants or memory in your repo. Where those already live there, the surface is convenience. Where they do not, the surface only makes the gap quicker to reach.

## Where Claude Tag is the better buy

Anthropic's product is the shorter path when nobody on the team wants to run a server or review a manifest. An Owner provisions the identity, and the channel works that afternoon. Organization identity, spend caps and an activity log arrive already wired in. That is real work you do not do, and a team without an operator should count it. Claude Tag works in Slack today, so a team that lives in Teams should treat any pilot as a Slack pilot.

## Side by side

| Dimension | Kortix | Claude Tag |
| --- | --- | --- |
| Open source | Yes | No |
| Agent defined in | A file in your repo | Anthropic's admin console |
| Access granted in | Manifest grants, deny by default | Console levels set by an Owner |
| Who approves work | A reviewer on a change request | Anyone in the channel with access |
| Where memory lives | The project repo | Channel memory inside Claude |
| Where it runs | Cloud, your VPC, or on-prem | Anthropic's platform, Slack today |
| Time to first answer | A repo and a manifest | An install and an Owner |

For the same decision on other surfaces, read [Kortix vs Copilot Studio](/blog/kortix-vs-copilot-studio) and [what ChatGPT Work's control page admits](/blog/chatgpt-work-enterprise-controls-recheck). The [open-source Claude Cowork alternatives](/blog/open-source-claude-cowork-alternatives) cover the desktop side of the same question.

Kortix is free to start and free to self-host. [Try Kortix](https://kortix.com).
