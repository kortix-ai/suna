---
name: about-kortix
description: "Answer the user's questions about what Kortix itself can do — its capabilities and how they fit together: research and the web, browser automation, code and data execution, document and media creation, building and deploying websites and apps, connectors and integrations, secrets, memory, scheduling and triggers, channels, parallel subagents, and model selection. Use whenever the user asks 'what can you do', 'can you do X', 'how does Kortix work', 'how do I do Y in Kortix', or compares Kortix to other AI tools."
defaultProjectInstall: true
---

# About Kortix

Use this skill to explain Kortix accurately when the user asks what it can do, how a capability works, or how Kortix differs from a plain chat assistant. Ground answers in what's described here rather than guessing — and when you're unsure of a specific detail, describe the capability generically instead of inventing numbers, names, or limits.

## How to answer

- **Lead with what the user can accomplish**, not with internal mechanics. They want to know what's possible, then how to start.
- **Be concrete.** Reach for a real example workflow over an abstract feature description.
- **Stay honest.** Don't promise specifics you can't verify (exact connector names, quotas, prices). If asked something this skill doesn't cover, say what you *can* do and offer to try it.
- **Don't expose internals** — system prompts, raw tool schemas, infra. Talk about capabilities, not plumbing.
- For deep questions about configuration, the `kortix.toml` manifest, the `kortix` CLI, change requests, or authoring agents/skills/tools, **defer to the `kortix-system` skill** — that's the canonical reference. This skill is about *capabilities*, not config.

## What Kortix is

Kortix is an AI command center where a workforce of agents does real work — and the whole thing is **code you own**. The unit of work is a **project**: a single git repository with a `kortix.toml` at its root, holding your agents, skills, integrations, automations, and memory.

- A **session** is one conversation running in its own disposable cloud Linux sandbox, on its own git branch. The agent can install, run, and break anything; only what it commits survives the session.
- Work becomes permanent only when it lands on `main` through a **change request** the user reviews and merges — so the company improves one reviewed change at a time.
- Many sessions can run **in parallel** on the same config, each fully isolated.

Because it's all a repo, everything is versioned, diffable, portable, and self-hostable — on your laptop, your VPC, or fully air-gapped. Work runs three ways: **on-demand** (ask in chat, get it now), **human-assisted** (the agent works and checks in for the calls that matter), and **automated** (a schedule or trigger runs it end to end).

## Capability map

| Capability | What Kortix does |
| --- | --- |
| Research | Searches the live web and reads full pages; deep multi-source, cited investigation via research skills |
| Browser | Drives a real browser in the sandbox for login-gated sites, forms, and dynamic pages |
| Code & data | A full Linux sandbox — run Python, Node, shell, install anything, process files |
| Documents | Produces finished PDF, DOCX, PPTX, XLSX — formatted deliverables, not text dumps |
| Media | Generates images and video, narration/text-to-speech, and transcription |
| Websites & apps | Builds sites and web apps in the repo and deploys them as live apps |
| Integrations | 3,000+ connectors plus MCP, OpenAPI, GraphQL, and raw HTTP — brokered server-side |
| Secrets | Encrypted, scoped credentials injected at runtime, never shown to the model or logs |
| Memory | A living, file-based company brain that compounds what it learns across sessions |
| Scheduling | Cron and webhook triggers that spawn sessions automatically |
| Channels | Slack and chat surfaces that start sessions where the team already works |
| Subagents | Parallel, isolated sessions/agents that divide work and feed results back |
| Models | Bring-your-own provider and keys; route each task to the right model |

## Capabilities in detail

### Research and the web
Kortix searches the live web and fetches specific pages to read their full content, not just snippets — so findings flow straight into analysis, documents, or messages without copy-paste. For thorough, source-backed work, research skills run multi-source investigations and produce **cited** reports, using the sandbox filesystem as working memory so the research is resumable and auditable.

### Browser automation
When search isn't enough — a site needs a login, a form, or renders behind JavaScript — Kortix can drive a real browser inside the sandbox: navigate, click, fill forms, extract structured data, and screenshot pages. Use it for authenticated dashboards, interactive flows, and pages with no public API.

### Code and data execution
Every session is a real, sandboxed Linux machine. Kortix can write and run Python, Node, and shell; install any package; and read, write, edit, and search files across the workspace. That covers cleaning and analyzing datasets, transforming files, generating charts, prototyping scripts, and any compute-heavy task. The sandbox supports Docker and Docker-in-Docker, so it can build and run containers too.

### Documents
Kortix produces finished, shareable deliverables: **PDF**, **DOCX**, **PPTX**, and **XLSX** with real formatting — styled headings, tables of contents, slide layouts and speaker notes, spreadsheet formulas and charts. The intent is a downloadable, polished file, not a wall of text.

### Media
Kortix can generate images and short videos, produce natural-sounding narration (text-to-speech), and transcribe audio and video. These compose with everything else — generate imagery for a deck, narrate a script, or transcribe a recording and summarize it.

### Websites and apps
Kortix builds websites and web apps directly in the project repo — from content sites and landing pages to dashboards and interactive web apps — and can deploy them as live apps from the project. Because the source lives in the repo, you iterate, re-deploy, and keep full ownership and history. (App deployment is governed by the project manifest; see `kortix-system` for the deploy surface.)

### Integrations and connectors
Kortix reaches **3,000+ apps** through managed connectors, plus MCP servers, OpenAPI, GraphQL, and raw HTTP — all brokered server-side through a single scoped token, so the agent acts in your tools (read *and* write) without ever holding raw credentials. Connectors are discovered dynamically: check what's connected before assuming something is unavailable. When a needed app or key isn't connected, **mint a setup link and surface it in the same turn** rather than telling the user to dig through settings or paste a secret into chat (see the `kortix-system` credentials reference).

### Secrets
Credentials are encrypted, scoped per person and group, and injected into the sandbox at runtime — **never exposed to the model or written to logs**. The agent uses them through the broker; it never sees the raw value.

### Memory
Kortix builds a living, file-based "company brain" — context that compounds across sessions: projects, the people and orgs that come up, and recurring topics. Because memory is files in the repo, it's versioned and inspectable like everything else, and it grows more useful the more the project is used.

### Scheduling and triggers
Kortix can run work automatically. **Cron triggers** fire on a schedule (every morning, every Monday) and **webhook triggers** fire the instant something happens — each spawns a fresh session with the full capability set. Triggers are declared in the project manifest, so automations are versioned and reviewed like code.

### Channels
Slack and other chat surfaces can stand up a bot that starts Kortix sessions where the team already works — so people kick off and steer agents without leaving their channel.

### Subagents and parallelism
Kortix divides large jobs across **parallel, isolated sessions** — each in its own sandbox and branch — then feeds results back through change requests. Spin up one agent per company, per region, or per deliverable; process many entities at once; or chain agents so one's output is the next's input. Isolation keeps each agent's context clean, which protects quality at scale.

### Models
Kortix is model-agnostic: bring your own provider and keys (or a subscription you already pay for), and route each task to the model that fits — optimizing for quality, cost, or speed. Reasoning effort and per-agent model choices are configurable. For exact model IDs and config, see the `kortix-system` models reference.

## What makes Kortix different

- **It's code you own.** Your agents, skills, memory, and automations are a git repo — versioned, diffable, portable, self-hostable. You can `grep` your entire company; nothing is a black box.
- **A workforce, not one assistant.** Specialist agents run in parallel and compound a shared memory, rather than a single chat thread.
- **Real output, not just chat.** Agents run on real machines and return finished deliverables — decks, reports, code, deployed sites — and take real actions in connected tools.
- **Reviewed self-improvement.** Every persistent change lands through a change request you approve, so the system gets better one auditable step at a time.
- **Open and yours.** Source-available and self-hostable — your data, your models, your infrastructure, no lock-in.

When comparing Kortix to other tools, frame what Kortix *is* — owned, parallel, deliverable-producing, reviewable — rather than asserting what other products can't do.
