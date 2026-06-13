# Kortix Glossary — Canonical Terms

Companion to `../SKILL.md`. Definitions trace to `suna/MANIFESTO.md` and `suna/README.md`. Style product nouns and config tokens in Roobert Mono (per brand-guidelines). Use these spellings exactly.

## Brand names

- **Kortix** — the company and the platform. Lead with this everywhere.
- **Suna** — the open-source repository the platform lives in (`kortix-ai/suna`). Some existing skills say "Kortix/Suna." In outward copy, prefer **Kortix** alone unless you specifically mean the repo.
- **Kortix Cloud** — the managed hosting. Capitalize both words.
- **Platinum.dev** — the compute floor under the platform (CPU/GPU sandboxes, inference, training). Lowercase `.dev`.

## Core objects

- **Project** — a git repo that *is* the company: configuration plus accumulated state, all text, all version-controlled. Not "workspace" or "account."
  - Say: "your project is a repo you own." Not: "your workspace in our cloud."
- **`kortix.toml`** — the Kortix layer of a project: sandbox image, cron/webhook triggers, channels, apps, connectors, required secrets, and where agent config lives. Mono.
- **OpenCode config** — the runtime agents think in: agents, skills, commands, tools, plugins, models, providers.
- **Session** — one unit of agent work, running in its own sandbox on its own branch, owned by whoever or whatever started it. Not "chat," "thread," or "conversation."
  - Say: "start a session." Not: "open a chat."
- **Sandbox** — the disposable, microVM-isolated Linux machine a session runs in. The agent can install, run, and break anything; only what it commits survives. In external copy say "sandbox," not "container."
- **`kortix-sandbox-agent-server`** — the daemon a sandbox boots with: clones the repo, cuts the branch, loads config into a live runtime, and exposes prompting/streaming/files/terminal. Mono. Mostly internal; rarely in marketing copy.
- **Change request** — the reviewed merge back toward `main`; how work lands and how the company self-improves, one approved change at a time. CLI: `kortix cr`. Behaves like a pull request, but in product copy say "change request."
  - Say: "the agent opens a change request you approve." Not: "the agent deploys."

## The pieces you work with

- **Agent** — a markdown persona with a prompt and a tightly scoped reach into tools and resources. Installable in one click; can rewrite itself. Not "bot."
- **Skill** — markdown plus scripts that encode how the company does a specific job; lives in the repo and rides into every session. The part that compounds.
- **Connector** — one-click reach into 3,000+ apps, plus MCP, OpenAPI, GraphQL, and raw HTTP, brokered server-side through one scoped token. Noun = "connector"; verb = "connect." Not "plugin" or "integration."
- **Secret** — an encrypted, per-person/per-group credential injected into sandboxes at runtime, never shown to the model or logs, enforceable at the network.
- **Channel** — a chat surface (Slack, Teams, Telegram, WhatsApp, SMS, email) where one click stands up a bot that starts sessions where people already are.
- **Trigger** — a cron schedule or signed webhook that spawns sessions automatically.
- **Memory** — the living company brain: plain files today, a system that compounds what it learns over time. In external copy, not "vector database."
- **App** — a declarative, durable deployment: define a service in config, get a real one listed under the project.

## How work runs (three modes)

- **On-demand** — ask in chat, get it now.
- **Human-assisted** — the agent works and checks in for the calls that matter.
- **Automated** — runs on a schedule or trigger, end to end.

## Capitalization & style quick rules

- **Kortix**, **Suna**, **Kortix Cloud**, **Platinum.dev** — exactly as written above.
- Product objects (project, session, sandbox, agent, skill, connector, secret, channel, trigger, memory, app, change request) are common nouns — lowercase in prose, capitalized only at sentence start or as table/UI labels.
- Config tokens and commands in Roobert Mono: `kortix.toml`, `kortix init`, `kortix ship`, `kortix cr`, `main`.
- "git repository" / "repo," "`main` branch," "change request" — lowercase.
