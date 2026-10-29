---
title: "ChatGPT Work keeps the controls; the open-source alternative keeps the record"
description: "ChatGPT Work gives admins real controls. Who changed an agent's access is the open question. Open-source Kortix keeps that record in a git repo you own."
date: "2026-10-21"
canonical: "https://kortix.com/blog/chatgpt-work-for-enterprise"
author: "team"
tags: ["Field notes"]
updated: "2026-10-21"
slug: "/chatgpt-work-for-enterprise"
---
ChatGPT Work is a strong finished-work agent inside ChatGPT; Kortix is the open-source alternative a company can own, and the one that can still show the record afterwards. A security reviewer asks who widened an agent's access at two in the morning last Tuesday, and the acceptable answer is a record with a timestamp and an author. Work plans, reaches your apps and files, and returns a finished spreadsheet or deck. Whether your company can prove what it was allowed to reach is a different question, and it decides the rollout.

> Every enterprise control in ChatGPT Work exists. Whether the record of a change exists anywhere you own is the open question.

```logos
label: 'Compared here:'
items:
  - { name: ChatGPT Work, domain: openai.com }
```

Kortix is the open-source AI Operating System: your agents, their skills, your company memory, and every connector in one git repo you own, with the agents working on real cloud computers.

## What an enterprise admin actually gets

ChatGPT Enterprise is a subscription workspace: OpenAI's models and agents behind an admin console, with role-based model access and the Compliance API. Work runs inside it under the same security boundary as Codex, so a company can put it in front of its teams now ([ChatGPT Work overview](https://learn.chatgpt.com/docs/enterprise/chatgpt-work-overview), checked October 2026).

OpenAI documents the admin controls better than most vendors document theirs, and they are real. A workspace owner can turn local computer access on, set approval policy, and decide which connected apps an agent may touch. Each of those is a decision someone at your company will be asked to defend.

- **Execution is split, and the split is written down.** OpenAI's cloud coordinates the task. Individual steps run in a cloud environment or on an approved, connected computer.
- **The local toggle sits in one place.** A workspace owner enables **Allow local computer access** under Work Cloud in **Agent Security**. That comes after reviewing the required Work permissions and the cloud policy.
- **A cloud container is not the laptop.** "A task cannot switch from local execution to the cloud during a turn." A cloud container "does not automatically inherit a computer's files, applications, browser sessions, or network access." Local execution restrictions "do not automatically apply to these cloud computers."
- **Connected apps start closed on the strictest plans.** "For Enterprise and Edu workspaces, plugins and their underlying apps are off by default. For Business workspaces, plugins and apps are on by default."
- **Approvals and search live in one policy.** Orchestrator controls, including approvals and web search, stay in Global.

A reviewer can work with that list. Every item on it is also a setting inside OpenAI's admin console. A console tells you what is true now. It will not hand you the state of a setting on the night it changed, in a format your auditor accepts, for more than a month.

## Where each control lives

The same decisions, on each side, sorted by where the setting actually lives.

```compare
them: ChatGPT Work
rows:
  - dimension: Open source
    them: "No"
    kortix: Yes, self-host or managed cloud
  - dimension: Local computer access
    them: Allow local computer access, nested under Work Cloud
    kortix: A grant in kortix.yaml, reviewed as a diff
  - dimension: Approval policy
    them: Global policy in the admin console
    kortix: policy.default_mode in the manifest
  - dimension: Connected apps
    them: Off by default on Enterprise and Edu
    kortix: A connector list per agent, checked by validate
  - dimension: Who holds the config
    them: OpenAI's admin console
    kortix: A git repository your company owns
  - dimension: Audit record
    them: Compliance API events, 30-day platform records
    kortix: Named actions, filtered and streamed by prefix
  - dimension: Where it runs
    them: OpenAI's cloud
    kortix: Kortix Cloud, your VPC, on-prem
  - dimension: Time to first control
    them: Minutes, and no repository required
    kortix: One manifest, plus a change request
    lean: them
```

## The record is the part the console will not promise

OpenAI states the limit itself, in a sentence about what an administrator can see after a run finishes. "These user-visible records don't establish Compliance API export or a complete administrator-visible execution history."

Admin-defined MCP hooks go further, with a limit of their own. They exist for supported lifecycle and tool events, and "MCP hooks do not provide a complete Compliance API audit trail." Compliance Logs Platform records stay available for 30 days.

The enterprise page offers "centralized visibility, auditability, and governance controls, including Compliance API visibility for conversations and agent activity" ([ChatGPT Enterprise](https://chatgpt.com/business/enterprise/), checked October 2026). That is a visibility promise about conversations and agent activity.

A governance review asks something narrower: who enabled local computer access, who added the payment connector, and what the configuration looked like before. Answer from a console, and the answer is whatever the vendor's admin log happens to retain, in the vendor's shape. When the console holds the only copy, the company rents its own evidence.

## The control surface is a file

In Kortix the same decisions sit in a manifest at the root of a project repository, next to the code they govern. This is a working excerpt:

```yaml
kortix_version: 2
default_agent: support

env:
  required: [STRIPE_API_KEY]

connectors:
  - slug: stripe
    provider: composio
    app: stripe

agents:
  support:
    file: agents/support.md
    connectors: [stripe]
    secrets: [STRIPE_API_KEY]
    kortix_permissions: none

policy:
  default_mode: risk
  policies:
    - match: stripe.*
      action: require_approval
```

Two lines carry most of the governance. `policy.default_mode` falls back to `allow_all`, so a manifest with no policy block lets a connector call through when no rule matches. `risk` sends a write or a destructive call to approval. `kortix_permissions: none` is the support agent's whole grant on the project. An omitted grant also means none, so a new agent starts with nothing and someone has to add a line for it to get more.

Validation runs before anything lands. `kortix validate` checks the manifest and the files around it. It reports a missing agent `.md`, a connector slug the `connectors` list never declares, or a secret name `env` never declares. It exits 0 with no errors and 1 with one or more. The same schema check runs in `kortix ship` and in the change request merge check, so an error blocks the push or the merge. `kortix validate --scopes` prints every grantable `kortix_permissions` entry, which turns a scope review into picking from a list rather than reading free text.

One honest gap: `kortix validate` does not check `policy` or `policies`. A malformed rule is skipped when connectors sync and shows up as a connector sync error, so check the rules after the change lands. Session work reaches `main` through a change request. Merge is default-deny for agents. The review that matters is a diff of that file, not a screenshot of a settings page.

## An audit row names the action, not the conversation

Kortix names every recorded action as `domain.resource.verb`, for example `gateway.key.revoke`. An action says what changed, not which chat mentioned it. `kortix audit ls --action gateway.` filters by prefix. `kortix audit webhooks add --action-prefix gateway.` streams every matching action to a destination you control, so a SIEM or a warehouse keeps its own copy ([audit actions](https://kortix.com/docs/audit-actions), checked October 2026).

Each request row also keeps `metadata.http`, the route template of the call. A row reads `DELETE /v1/projects/:projectId/gateway/keys/:keyId`. The raw path is never recorded, because a path segment can be a setup or approval link token. The reference lists 797 request actions, 81 events outside a request, and 55 operator actions. That is enough detail to write filters a reviewer can trust.

Every action is recorded. Reading, exporting and streaming the audit log depend on the plan, which is worth checking before an audit rather than during one.

## Identity, then the keys to the building

Kortix supports SAML 2.0 single sign-on and SCIM 2.0. The account reads group membership from a claim you name. Entra is the useful example: it sends group object IDs by default, so set the claim name to `memberOf` before group mappings mean anything ([sign-in and SSO](https://kortix.com/docs/accounts/identity), checked October 2026). Once a domain is verified, Enforce SSO refuses password sign-in, magic links and email codes for it, and ends existing sign-ins made another way.

Then the infrastructure question. Run it on Kortix Cloud, in your VPC, or on your own on-prem network. Self-host is free, and domain mode is the production setup: Caddy terminates TLS, and one Compose project, `kortix-<instance>`, holds the frontend, the API, the LLM gateway and the database ([self-hosting](https://kortix.com/docs/host), checked October 2026).

## What ChatGPT Enterprise costs

OpenAI publishes no per-seat Enterprise price, and its enterprise page routes a buyer to a sales conversation. What a company pays comes from a credit-based or a token-based rate card, depending on the agreement it signs ([models and limits](https://help.openai.com/en/articles/11165333-chatgpt-enterprise-and-edu-models-and-limits), checked October 2026). Token-billed agreements keep billing usage after the subscription starts, so the meter deserves a look before the rollout, not after it.

## When to pick which

```verdict
themLabel: ChatGPT Work
them: You want a console your IT team can run without a repository, and the work stays inside ChatGPT.
kortix: You have to show who changed an agent's access, and hand the record to an auditor yourself.
```

For the end-to-end comparison, [ChatGPT Work against an open-source alternative you can own](/blog/open-source-chatgpt-work-alternative) covers seats, model access and the price floor. [How the review gate separates open-source platforms](/blog/open-source-ai-agent-platform) goes deeper on approvals. [Kortix vs Copilot Studio](/blog/kortix-vs-copilot-studio) makes the tenant-ownership case from the Microsoft side.

Own the control surface, not just the console. Start with [Kortix](https://kortix.com): free to start, free to self-host.
