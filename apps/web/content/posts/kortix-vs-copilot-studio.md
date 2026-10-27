---
title: "Open-source Kortix keeps the agent in your repo; Copilot Studio keeps it in Microsoft's tenant"
description: "Copilot Studio defines, versions and runs agents inside Microsoft's tenant; open-source Kortix keeps the agent in a git repo your team owns."
date: "2026-10-18"
canonical: "https://kortix.com/blog/kortix-vs-copilot-studio"
author: "team"
tags: ["Comparisons"]
updated: "2026-10-21"
slug: "/kortix-vs-copilot-studio"
---
Microsoft Copilot Studio is a capable low-code studio for building agents inside a Microsoft 365 tenant, and Kortix, the open-source AI Operating System, asks a different question about the same work: where is the agent defined, versioned and run? In Copilot Studio the answer is Microsoft's cloud at every step. The agent is built in the studio, stored in a Power Platform solution, published into Microsoft's surfaces and billed to the tenant in Copilot Credits. In Kortix the answer is a file in a repo your team owns.

```logos
label: 'Compared here:'
items:
  - { name: Microsoft Copilot Studio, domain: microsoft.com }
```

## What Copilot Studio does well

- **Low-code for the whole team.** Microsoft's own pages say you can build capable solutions without an extensive technical background, while professional makers keep the depth they need ([Copilot Studio overview](https://learn.microsoft.com/en-us/microsoft-copilot-studio/fundamentals-what-is-copilot-studio)).
- **Reach inside Microsoft 365.** Agents publish into Teams, SharePoint and Microsoft Copilot, where employees already work ([Copilot Studio](https://www.microsoft.com/en-us/copilot/products/copilot-studio)). Entra ID authentication is on by default for Teams and Microsoft Copilot ([Publish and deploy your agent](https://learn.microsoft.com/en-us/microsoft-copilot-studio/publication-fundamentals-publish-channels)).
- **Enterprise plumbing included.** The platform documents a Dev-Test-Prod lifecycle with version control, release pipelines and approval gates, plus audit logs that flow into Microsoft Purview ([Copilot Studio](https://www.microsoft.com/en-us/copilot/products/copilot-studio)).
- **Prebuilt connectors.** Power Platform's standard and premium connectors are built in, and custom connectors reach any public API ([Use connectors in Copilot Studio agents](https://learn.microsoft.com/en-us/microsoft-copilot-studio/advanced-connectors)). Work IQ tunes agents for the tenant's own workflows.
- **A serious runtime for hard work.** The GitHub Copilot harness takes a goal, breaks it into steps and runs each task in a sandbox governed by Copilot Studio, a Studio framework rather than the GitHub Copilot service itself ([Harnesses in Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/harnesses-overview)).

For a company that runs on Microsoft 365, that list is the product working as intended, until the question turns to ownership.

## The tenant boundary is the lock-in

Every Copilot Studio agent is an object inside Microsoft's cloud, and Microsoft's docs say so plainly: creating an agent creates it within a Power Platform solution, the unit that moves agents between environments ([Create and manage custom solutions](https://learn.microsoft.com/en-us/microsoft-copilot-studio/authoring-solutions-overview)). Definition, version history and runtime all sit on Microsoft's side of the wall. The studio is where you visit the agent; Microsoft's cloud is where the agent lives.

Publishing wires a channel to the agent and leaves the runtime where it is. The channels doc lists live websites, mobile apps, Microsoft Copilot, Teams and Facebook ([Publish and deploy your agent](https://learn.microsoft.com/en-us/microsoft-copilot-studio/publication-fundamentals-publish-channels)). The pricing page draws the same line: a Microsoft 365 Copilot license covers agent building for internal use, and reaching outside channels takes a standalone Copilot Studio plan ([Copilot Studio pricing](https://www.microsoft.com/en-us/copilot/pricing/copilot-studio)).

Billing follows the tenant too. Copilot Credits measure the time and effort an agent needs to retrieve information, respond and use its actions ([Standard harness licensing](https://learn.microsoft.com/en-us/microsoft-copilot-studio/billing-licensing)); they replaced the old message currency on 1 September 2025. The standalone plan is sold as tenant-wide packs of 25,000 credits a month, each a tenant license ([capacity packs](https://learn.microsoft.com/en-us/microsoft-365/copilot/pay-as-you-go/copilot-capacity-packs)), listed at $200 a month (checked October 2026) ([Copilot Studio pricing](https://www.microsoft.com/en-us/copilot/pricing/copilot-studio)). A trial license builds and tests an agent in the test chat but cannot publish it. The maker license is free of charge only once the tenant holds a prepaid Credit pack, unused credits do not carry over, and usage beyond purchased capacity can end in service denial.

That is what software sold to a tenant looks like, and it puts the real question below the feature grid: what do you hold when the build is done, and who can read it?

## The agent as a file you own

Kortix answers that question with a different object. A Kortix project is a git repo with `kortix.yaml` at its root, and the agents, skills, memory, tools, triggers and connectors are files inside it ([Kortix docs](https://kortix.com/docs)). The starter project every new deployment begins with shows the shape, and its header states the division of labour:

```yaml
# yaml-language-server: $schema=https://kortix.com/schema/kortix.v2.schema.json
#
# Kortix project manifest. Source of truth for project-wide config that
# lives in git alongside the code. `kortix_version` pins the schema so
# the platform can evolve safely. v2 manifests are YAML-only, with one
# `agents:` map per project — GOVERNANCE ONLY (connectors/secrets/
# kortix_permissions/skills/workspace/enabled), plus `file`, the path of the
# agent's `.md`. Agent BEHAVIOR (description, model, mode, temperature,
# permission, the prompt itself, …) lives entirely in that `.md`'s
# frontmatter + body — a stock OpenCode agent file works as-is.
```

Nothing in the manifest says what an agent is for, what model it runs or how it is prompted. It names the file and grants the access. The front-door agent lives beside it as a markdown file, in the starter's own text:

```markdown
You are a **Kortix general knowledge worker** for **{{projectName}}**.

You are hands-on: you read, edit, run, search, fetch, and ship. The
session you're in is an isolated sandbox — an ephemeral branch of
this repo, your own `/workspace` — so you can install, experiment,
and recover freely. Only what you commit + push survives.
```

An agent is `agents/<name>.md` for behavior plus an `agents.<name>` block in `kortix.yaml` for governance. That pair is the whole definition. The block is short: `file` names the markdown, then the grants, then `workspace`, the git boundary a session gets. Everything you would argue about in review sits in the file the review can diff. The v2 manifest is deny by default, so an omitted grant resolves to none, and the starter's own agent carries `all` on connectors, secrets, permissions and skills so a fresh project works before you narrow it. The versioning story follows: a session is a branch of the repo, so the agent's history is the repo's git history.

Kortix is open source. Read it, fork it, audit it ([Kortix on GitHub](https://github.com/kortix-ai/suna)). Run it on Kortix Cloud, in your VPC or on-prem, and self-hosting is free. The work comes back reviewable: nothing merges itself, because work reaches `main` through a change request a person approves unless an admin grants the merge capability. That capability is `project.gitops.merge`, and the starter's `all` includes it, so a project that needs a person at every merge narrows `kortix_permissions`.

The bill follows the same ownership story. Free is $0 with 500 credits per month, every feature and 1 project, on your own provider keys or your ChatGPT subscription. Managed models are on the Credits plan only. Paid plans start at $50 a month for 5,000 credits, with unlimited and free members sharing one credit pool, and unused monthly credits roll over one month ([Kortix pricing](https://kortix.com/pricing)).

## What moves and what gets rebuilt

Microsoft documents one way to move a Studio agent: as a Power Platform solution, exported and imported between environments ([Export and import agents using solutions](https://learn.microsoft.com/en-us/microsoft-copilot-studio/authoring-solutions-import-export)). The agent instructions travel. Custom topics and knowledge sources stored as separate resources or Dataverse tables might not. Conversation IDs, bot IDs and environment IDs do not transfer, the imported agent arrives with an empty icon and no channel details, authentication is configured again, and the agent must be published before it can be shared. Running an agent outside Microsoft's platform is not a documented use of the export.

In Kortix the same move is a clone: the agent is already a file, so moving means cloning the repo and running it wherever the platform runs. Coming the other way, a Studio agent's main prompt becomes an `agents/<name>.md` file, and its connectors and triggers get declared in `kortix.yaml`. The topic tree and the flows do not travel: a topic becomes a prompt plus skills you write, and Power Automate flows become triggers and project tools.

## Where Copilot Studio is the better pick

- **Your people work in Microsoft 365.** Agents that answer in Teams, SharePoint and Microsoft Copilot meet employees where they already are ([Publish and deploy your agent](https://learn.microsoft.com/en-us/microsoft-copilot-studio/publication-fundamentals-publish-channels)). For internal agents that reach comes with the Microsoft 365 license, and Copilot Studio is available in the US Government Community Cloud plan.
- **Non-developers build the agents.** Microsoft's pitch is that low-code lets people close to the work build capable solutions, and its designer hands those makers drag-and-drop workflows ([Copilot Studio overview](https://learn.microsoft.com/en-us/microsoft-copilot-studio/fundamentals-what-is-copilot-studio)). Kortix asks for a repo, a review habit and, on self-hosted deployments, someone who runs it.
- **The compliance surface is prebuilt.** Audit logs flow into Microsoft Purview and the platform documents data-residency alignment ([Copilot Studio](https://www.microsoft.com/en-us/copilot/products/copilot-studio)). That is a real advantage when your security review is written around Microsoft's controls.

If your company will run on Microsoft 365 for the foreseeable future and wants its own makers building agents inside it, Copilot Studio is the right tool. The comparison turns when the agent has to be something you hold rather than something you visit.

## Side by side

The table holds the rows a Studio buyer decides on.

```compare
them: Copilot Studio
rows:
  - dimension: Open source
    them: "No, a closed product"
    kortix: "Yes, self-host or managed cloud"
    lean: kortix
  - dimension: Where the agent is defined
    them: "In the studio, on Microsoft's cloud"
    kortix: "Agents and skills as files in one git repo"
    lean: kortix
  - dimension: Where it runs
    them: "Microsoft's cloud, on the Power Platform"
    kortix: "Self-hosted or managed cloud, your choice"
    lean: kortix
  - dimension: Who pays for the compute
    them: "Copilot Credits, billed to the tenant"
    kortix: "Your model keys and your own infrastructure"
    lean: kortix
  - dimension: Pricing
    them: "Credit packs at $200 a month, or pay-as-you-go"
    kortix: "Free with 500 credits a month; paid from $50"
    lean: kortix
  - dimension: Publish to
    them: "Teams, SharePoint, Microsoft Copilot, websites, mobile apps"
    kortix: "Web, Slack, Teams, CLI, API, MCP"
    lean: them
  - dimension: Review before work lands
    them: "Environment pipelines and approval gates"
    kortix: "A change request, and merge is default-deny for agents"
    lean: both
  - dimension: Choose your models
    them: "The models Microsoft offers in Studio"
    kortix: "Any model, your keys"
    lean: kortix
  - dimension: Export the agent
    them: "A Power Platform solution between environments"
    kortix: "The repo is the export"
    lean: kortix
```

## When to pick which

```verdict
themLabel: Copilot Studio
them: "You want agents your employees reach inside Teams, SharePoint and Microsoft Copilot, your tenant already runs Microsoft 365, and citizen developers will build and maintain the agents in a low-code studio."
kortix: "You want the agent defined, versioned and run in a repo you own, on any model with your own keys, with a person approving the change request before work reaches `main`."
```

The [open-source Copilot map](/blog/open-source-microsoft-copilot-alternative) covers the org-scale agent lane, and [Kortix vs Gumloop](/blog/kortix-vs-gumloop) runs the same comparison against a hosted builder.

```cta
title: Put the agent in a repo you own
body: Free to start, free to self-host.
```

Start with [Kortix](https://kortix.com) on managed cloud or self-host it free. The agent, its history and its review gate stay in a repo your team can read.
