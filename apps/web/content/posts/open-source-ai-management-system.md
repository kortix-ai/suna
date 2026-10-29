---
title: "Open source is what makes an AI Operating System yours"
description: "Kortix is open source: one git repo for the agents, skills, memory and connector config, self-hosted or managed, on any model."
date: "2026-07-31"
canonical: "https://kortix.com/blog/open-source-ai-management-system"
author: "marko"
tags: ["Product", "Architecture", "Open Source"]
updated: "2026-10-21"
slug: "/open-source-ai-management-system"
cover: "/banner.png"
leadMedia: {"poster": "https://kortix.com/media/showcase/kortix-showcase-poster.jpg", "sources": [{"src": "https://kortix.com/media/showcase/kortix-showcase-1920.mp4", "type": "video/mp4"}, {"src": "https://kortix.com/media/showcase/kortix-showcase-1280.mp4", "type": "video/mp4"}], "alt": "Kortix in the browser: a project and its connectors, agents, skills and schedules, then a session working on a cloud computer and returning a finished deck.", "aspectRatio": "1920 / 1200"}
---
Most AI tools ask you to move the company into their product. Kortix is the open-source AI Operating System, and the part that matters is a repository: agent prompts, skills, company memory and the connector configuration are text in a project you clone and run. The question that decides whether you own any of it is dull and decisive. Where does the configuration sit, and who can change it?

## One repo holds the whole company

Open a Kortix project and you open a git repository. That repository is the company: a manifest at the root, an `agents/` directory beside it, and markdown the rest of the way down. `kortix.yaml` names the machine image, the triggers, and what each agent may touch. Secret values never appear in it. An agent's behavior sits in `agents/<name>.md`; its governance sits in the `agents.<name>` block of the manifest. Company memory is the living company brain, and today it is plain files.

So the arrangement answers to `grep`. Every prompt, skill, remembered fact and grant is a line in a file with an author, a timestamp and a diff, and undo is `git revert`. `kortix init` turns a directory into a Kortix; [`kortix ship`](https://kortix.com/docs/cli) validates the manifest, commits every change, asks for missing secrets, pushes the current branch, and asks you to connect the connectors the project declares. The repo behaves identically on your laptop and in the cloud.

## The manifest is where governance becomes text

This manifest for a fictional company, Acme, declares two agents and one nightly job. Read it as a list of what the company allows.

```
# kortix.yaml, schema version 2.
kortix_version: 2
default_agent: kortix

project:
  name: acme

env:
  required:
    - STRIPE_SECRET_KEY

# Governance only. Behavior lives in agents/<name>.md.
agents:
  kortix:
    connectors: all
    secrets: all
    skills: all
    kortix_permissions: all
  # Read sessions, write memory/, push, open a change request.
  # The memory tool is the only Kortix tool this job needs; the
  # harness tools come from the agent's .md permission.
  memory-reflector:
    skills: none
    tools: [memory]
    kortix_permissions: [project.session.read, project.gitops.push,
                         project.review.submit]

# A trigger starts a session with nobody present.
triggers:
  - slug: memory-reflector
    type: cron
    agent: memory-reflector
    cron: "0 0 3 * * *"
    timezone: Europe/Berlin
    prompt: |
      Read the last day of sessions, update memory/,
      and open one change request.
```

`default_agent` sets the agent a session starts as. Every `agents:` block is governance, and the defaults differ by key: connectors, secrets and permissions start at `none`, while `tools` starts at `all` and `skills` fall back to the agent's `.md`. The two that do not start empty are the two written out here. The reflector can read sessions, write `memory/` through the memory tool, push a branch and open a change request. It holds no merge capability, so nothing it opens lands by itself. A trigger inherits the reach of the agent it names, which makes the agent block the part that matters.

There is no `channels:` block, and there cannot be one: schema version 2 rejects it, because channel routing is live project state rather than repo configuration. The same line runs through people. There is no Members node: members and roles are live project state.

## Connectors keep the key outside the machine

Each connector is set up once for the project, and every action on it is set to Allow, Ask or Block. Rules go down to the arguments of each call. An Ask holds the call: the agent's turn pauses and resumes when someone decides. An instruction in a prompt is a suggestion. Allow, Ask and Block are decided when the call is made, which is a different thing from asking a model to be careful.

Connector credentials are brokered server-side and never enter the machine. A secret you grant an agent is a different object. It arrives as an environment value, and any command in the session can read it. That asymmetry decides how much reach an agent should have, and the grant list is where you answer it. Approval gates are off until you set them, so the step that matters deserves an explicit Ask.

## Every session gets its own cloud computer

Each session has its own isolated machine and branch. A session boots a fresh sandbox, which clones the repository, cuts its own branch, and gives the agent a shell, a package manager and a filesystem. The machine is disposable: a bad install goes away with it, and only what the agent commits survives. Two sessions cannot touch each other, so thousands can run on one config.

Platinum is the reference provider, and its sandboxes are Cloud Hypervisor microVMs. That is the isolation boundary, and it stops short of the network. Nothing enforces network egress: a session reaches the internet, and no rule polices where it goes. The credential is the boundary that holds, which is why connector credentials are brokered outside the machine.

## Work arrives as a diff before main changes

Session work reaches `main` through a change request. Nothing merges itself.

That gate is what lets a company hand an agent real capabilities. The agent proposes; a person, or an agent an admin explicitly granted the merge capability, decides. Review moves to the diff, where it is cheap: a wrong step shows up as a changed line instead of a surprise in production. And because the diff is against the repository that holds the configuration, the review covers the company's own operating rules, not only the output. A reviewer reads the diff, not a transcript. That is why the repository and the gate belong together: the text under review is the same text that runs tomorrow.

## Self-hosting is a real option, with real limits

Run it on Kortix Cloud, in your VPC, or on your own on-prem network. Self-host is free, and [`kortix self-host start`](https://kortix.com/docs/host) brings the stack up on hardware you control. The offer has one limit worth stating plainly: the stack pulls its images from docker.io and the default sandbox provider is remote, so this is not an air-gapped deployment. Isolated topologies get scoped with us.

The compliance facts are as plain as the limits. SOC 2 Type I is verified; GDPR is a posture we run, not a certificate. On price, the Free plan costs $0 and includes 500 credits a month, every feature and 1 project, on your own provider keys or ChatGPT subscription. Paid plans start at $50 a month.

The point of the option is what it does to the relationship: the repository that ran on our cloud runs on yours, and the vendor becomes a hosting choice instead of the owner of the system.

## Side by side

The comparison is against the work modes Anthropic and OpenAI ship. Claude Cowork stopped being a separate product on September 16, 2026, when Anthropic made everything it does available from any Claude conversation on the Pro and Max plans ([release notes](https://support.claude.com/en/articles/12138966-release-notes)).

```compare
them: Claude Cowork · ChatGPT Work
rows:
  - dimension: Open source
    them: 'No'
    kortix: Yes, self-host or managed cloud
    lean: kortix
  - dimension: Where your configuration lives
    them: Inside the vendor's product
    kortix: A git repo you own
    lean: kortix
  - dimension: Which models it runs
    them: The vendor's own models
    kortix: Any model provider with your own keys
    lean: kortix
  - dimension: Where it runs
    them: A managed cloud, no self-host
    kortix: Kortix Cloud, your VPC, or on-prem
    lean: kortix
  - dimension: Version history on that configuration
    them: Not published
    kortix: '`git diff` on every agent, skill and grant'
    lean: kortix
  - dimension: How work lands
    them: Inside the product
    kortix: A change request you read as a diff
    lean: both
  - dimension: Getting started
    them: A paid plan, and nothing to operate
    kortix: Free to start; self-hosting is work
    lean: them
```

Next reads: [Kortix vs Claude Cowork](/blog/kortix-vs-claude-cowork), [Kortix vs Glean](/blog/kortix-vs-glean), and [Kortix vs Poetic](/blog/kortix-vs-poetic).

Run your whole company from one repo you own. Start with one job, connect its tools, and reach it from Slack, the web or the CLI. Free to start, free to self-host. [Try Kortix](https://kortix.com)
