---
title: "Six self-hosted AI workspaces, five open source, held to a team's three tests"
description: "Five open-source self-hosted AI workspaces and one fair-code option, judged on memory you can back up, a machine per session and a review gate."
date: "2026-09-20"
canonical: "https://kortix.com/blog/best-self-hosted-ai-workspace"
author: "team"
tags: ["Comparisons"]
updated: "2026-10-22"
slug: "/best-self-hosted-ai-workspace"
coverLogos: [{"domain": "openwebui.com", "name": "Open WebUI"}, {"domain": "anythingllm.com", "name": "AnythingLLM"}, {"domain": "dify.ai", "name": "Dify"}]
---
Most self-hosted AI lists are written for one person with a free weekend. Day one looks the same everywhere: a chat window, a model picker, a folder of PDFs. The differences arrive in the second month, when a second person needs what the first one taught the agent, when a session installs a package nobody vetted, or when finished work lands where nobody looked first. Six projects are worth running on your own hardware once a team is involved, five of them open source and one fair-code. Kortix, the open-source AI Operating System, is the one built for that second month. The rest are strongest at a narrower job.

## Three tests a demo never reaches

A demo is judged on the first conversation. A team needs three properties that only show up once real work starts.

- **Memory you can read and back up.** Ask where what an agent learned is stored, whether you can diff it, and whether last week's copy comes back after a bad migration. A store you cannot read is a memory you cannot audit.
- **A machine per session.** Work that installs packages and runs shell commands belongs on a computer it cannot escape, not on one sandbox shared by the whole company.
- **A moment where a person looks.** Writing files, sending mail, touching a CRM: each needs a gate that stops the agent until someone answers.

## Kortix: memory in files, a machine per session, one gate

A Kortix project is a git repository your company controls. Agents, skills, the memory they read and the rules for each connector are files in that repository, so any change to them arrives as a diff with an author and a date. Memory is plain files today, which means you can read it, grep it, and restore last week's copy with git.

The same git loop is the review path, and the [git docs](https://kortix.com/docs/git) show the whole of it. The clone lands in a directory named after the project id, not the project name, so that is the path the second line uses:

```
kortix projects clone <project_id>
cd <project_id>
git checkout -b tighten-triage
git commit -am "Tighten the triage prompt"
git push origin tighten-triage
kortix cr open --head tighten-triage --title "Tighten the triage prompt"
```

Six commands, and the work is a change request. One isolated sandbox per session. Each session has its own isolated machine and branch. Session work reaches `main` through a change request. Merge is default-deny for agents, so the person reading the diff decides, and an admin has to hand an agent the merge capability before that changes.

Connector calls carry a policy of Allow, Ask or Block, and an Ask holds the call until a person answers. Approval gates you set. Off until you set them. That default is the part teams miss: the change request gate ships switched on, while a connector policy is something a team writes once it knows which calls matter.

Run it on Kortix Cloud, in your VPC, or on your own on-prem network. Self-host is free, and the managed side is priced on [kortix.com/pricing](https://kortix.com/pricing).

Standing it up asks more of you than pulling a chat image does. The first run asks six things and no model key. GitHub connects in the dashboard (Settings → Git). Models are BYOK in the app. A team that only needs a private chat window over its own models will have Open WebUI answering questions before Kortix finishes its first boot.

## Open WebUI: the chat layer most teams already run

Open WebUI is the one most teams have installed already, and for the chat layer it is hard to beat. It runs entirely offline, reaches Ollama or any OpenAI-compatible endpoint, and treats identity as a first-class problem: roles and groups with per-resource permissions, LDAP, Active Directory, SSO and SCIM 2.0 provisioning ([Open WebUI features](https://docs.openwebui.com/features/)). Retrieval over your own documents needs no extra wiring, and Channels and Notes sit beside the chat.

Memory follows a person rather than the company. Open WebUI remembers facts about you across your own conversations, and that store never becomes shared knowledge. Open Terminal gives an agent a real machine with files and a shell, though Terminals are an enterprise-only offering ([Open WebUI for Enterprise](https://docs.openwebui.com/enterprise/)). Configuration lives in the product database rather than in a repo you can diff.

The license is permissive with one addition: the branding stays visible unless a deployment covers 50 or fewer people in a 30-day window, holds written permission, or carries an enterprise license ([Open WebUI License](https://docs.openwebui.com/license)).

## AnythingLLM: documents under an MIT license

AnythingLLM turns a folder of PDFs into working answers with less setup than the rest. It is local-first, with a no-code agent builder, MCP support and memory that belongs to a person rather than a team ([AnythingLLM on GitHub](https://github.com/Mintplex-Labs/anything-llm)). Multi-user support and permissioning run on the Docker deployment only, and the desktop build serves one person ([AnythingLLM README](https://github.com/Mintplex-Labs/anything-llm)). MIT licensing means you can fork it and ship it inside your own product ([AnythingLLM LICENSE](https://github.com/Mintplex-Labs/anything-llm/blob/master/LICENSE)).

Document retrieval is the job it does well. Company-wide knowledge is not. Memory is tied to the person: up to 20 facts per workspace, plus a global set of up to five that follows that person into every workspace they open, and no way to share either set with a teammate ([AnythingLLM memories](https://docs.anythingllm.com/features/memories)). Nothing here asks a person to approve work before an agent reaches a live system.

## LibreChat: model switching with approval controls built in

LibreChat gathers Anthropic, AWS Bedrock, Azure, Google, Vertex AI, OpenAI, any OpenAI-compatible endpoint and Ollama behind one interface ([LibreChat on GitHub](https://github.com/LibreChat-AI/LibreChat)). It also ships approval controls: a sandboxed code interpreter, admins setting Ask, Allow or Deny on file writes and command execution, subagents with their own context windows, and people, groups and roles over LDAP, OAuth2 or email login.

Knowledge is the gap. Files and history stay inside the chat that made them, and no company-wide memory is available to every agent, so the same context gets rebuilt by hand each time. It is MIT licensed ([LibreChat LICENSE](https://github.com/LibreChat-AI/LibreChat/blob/main/LICENSE)). A good pick when flexible model routing and sandboxed code matter more than a persistent team brain.

## Dify: AI applications built on a canvas

Dify is an application builder: a visual workflow canvas, a retrieval pipeline that ingests PDFs and slides, autonomous agents with their own sandbox, and hundreds of models ([Dify on GitHub](https://github.com/langgenius/dify)). Community Edition installs with Docker Compose and ships four built-in roles, Owner, Admin, Editor and Normal, with who can see an existing knowledge base set on the knowledge base itself ([Dify team members](https://docs.dify.ai/en/self-host/use-dify/workspace/team-members-management)). SSO and fine-grained RBAC need Enterprise ([Dify Enterprise](https://dify.ai/dify-enterprise)).

Its license is the Dify Open Source License, Apache 2.0 plus two conditions: one bars a multi-tenant service without written permission, the other keeps the console logo and copyright in place ([Dify LICENSE](https://github.com/langgenius/dify/blob/main/LICENSE)). Read them before you standardize. As a workspace it is an app builder first and a place for a team to work second.

## n8n: the automation layer behind the workspace

n8n automates workflows with AI steps: a visual canvas, JavaScript and Python nodes, human approval nodes, and 2,000+ integrations ([n8n integrations](https://n8n.io/integrations/)), self-hosted or cloud ([n8n self-hosting docs](https://docs.n8n.io/hosting/)). It is the one project here that does not call itself open source: n8n is fair-code, with visible source under the Sustainable Use License and an n8n Enterprise License alongside ([n8n on GitHub](https://github.com/n8n-io/n8n)). Self-hosting it is allowed; running it as a competing service is not.

n8n does have a chat surface, just not a shared one. The Chat Trigger node publishes a chat per workflow, and Hosted Chat renders it inside n8n without any extra setup ([Chat Trigger node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.chattrigger)). What a team cannot get from it is shared memory, since each chat belongs to the workflow that serves it. It works as plumbing between the tools your team already runs, which is a real job, and not the place where people and agents sit down to work.

## Side by side

The six differ most on where knowledge lives and who approves work before it lands.

| Option | Open source | Built for | Where it stops for teams |
|---|---|---|---|
| Kortix | Yes | Agents, memory and connector rules in one repo | Heavier setup than a single chat UI |
| Open WebUI | Open WebUI License, branding clause | Private, model-agnostic chat with strong identity | Personal memory; Terminals need Enterprise |
| AnythingLLM | MIT | Document chat and local RAG, no-code agents | Multi-user only on Docker; memory per person, none shared |
| LibreChat | MIT | Multi-model chat with sandboxed code execution | Knowledge stays inside each chat |
| Dify | Dify Open Source License, Apache 2.0 based | Visual AI app and workflow building | An app builder more than a team workspace |
| n8n | Fair-code (Sustainable Use License) | Workflow automation that connects systems | No shared memory; a chat per workflow |

Pick Kortix when all three tests apply. You want the agents, the skills and the memory in one git remote, a computer per session, and every change reviewed before it lands.

Pick Open WebUI when the work lives in conversations and enterprise identity is the hard requirement. AnythingLLM suits a document-heavy team, LibreChat suits multi-model chat with sandboxed code and admin-set approvals, Dify suits people building AI applications, and n8n is the automation layer behind whichever workspace you choose. Of the six, only one carries the memory, the isolation and the gate together.

For the reasoning behind the gate, read [why review decides which open-source system a team picks](/blog/open-source-ai-agent-platform) and our guide to [reliable agent workflows](/blog/how-to-build-reliable-ai-agent-workflows). For one rival on its own, read [Kortix vs Open WebUI](/blog/kortix-vs-open-webui).

Free to start, free to self-host. [Get started with Kortix](https://kortix.com).
