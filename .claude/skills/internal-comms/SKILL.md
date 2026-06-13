---
name: internal-comms
description: Use when writing or reviewing any Kortix-facing words — headlines, taglines, elevator pitches, audience pitches (developers, companies, enterprise), captions, deck or social copy, product naming, or text composited into images — or when another skill needs Kortix's canonical positioning, terminology, or approved wording. Verbal source of truth; pair with brand-guidelines for visuals.
---

# Kortix Internal Comms

The **verbal source of truth** for Kortix. `brand-guidelines` governs how Kortix *looks*; this skill governs what Kortix *says* — positioning, terminology, and approved wording.

Read this before writing any Kortix-facing words: a headline, tagline, pitch, caption, deck slide, social post, product name, or text composited into an image. When generating assets, pair it with `../brand-guidelines/SKILL.md`.

If a request conflicts with this skill, flag the conflict and offer the closest on-message alternative — the same discipline brand-guidelines uses for visuals.

## Positioning hierarchy

Four sanctioned lines. Each has one job — don't swap them.

| Layer | Line | Use for |
| --- | --- | --- |
| **Category** | Autonomous Company Operating System | What Kortix *is*. Analyst/enterprise framing, "what category is this" questions. |
| **Tagline** | The AI command center for your company | Headlines, hero, site, README. The default lead. |
| **Plain-language explainer** | A cloud computer where AI agents run your company | When "operating system" is too abstract — onboarding, press, non-technical readers. |
| **Manifesto line** | A company is going to be a git repository | The deep thesis. Manifesto, vision talks, founder voice. |

**One-line what-is:** Kortix is the Autonomous Company Operating System — a cloud computer where a workforce of AI agents runs your company, and everything is code you own.

## Elevator pitch

**Short (one sentence):** Kortix is the Autonomous Company Operating System — a cloud computer where a workforce of AI agents does real work for your company, and everything is code you own.

**Medium (~50 words):** Most AI tools give you a chat box. Kortix gives you a command center: one repo that *is* your company — its agents, skills, memory, and the machines they run on, all versioned and owned by you. A workforce of agents runs in parallel, returns real deliverables, and improves the company one reviewed change at a time.

## What it is, the problem, why now

**What it is.** One place to run an AI-native company. Your agents, skills, connectors, secrets, channels, triggers, and memory live in one repo that *is* the company — versioned, diffable, owned outright. It feels as simple as a chat app; underneath, everything is code you own.

**The problem it solves.** The models got good — but every session they wake up with no memory of you, your company, or your decisions. The tools built to fix that are demos: single-tenant, no isolation, no version history, no permissions, no security story. The only alternative is renting your company back from a model lab that keeps your data, config, and model. *A toy or a cage.* Kortix refuses both.

**Why now.** Reasoning is solved; memory, isolation, permissions, and ownership are not. Running a real AI workforce — thousands of isolated agents on one config, each feeding reviewed work back to `main` — is the unsolved part, and it's what Kortix is built for.

Full narrative, message house, and proof points: `references/messaging.md`.

## Mission & vision

- **Mission:** Take a company from human to AGI — and let it keep every byte of itself on the way there.
- **Vision:** A company is a git repository — thousands of agents on one config, each isolated, pushing work into a `main` branch that never stops running and keeps improving itself. CI/CD for the work of an organization, not just its code.

## Terminology quick-reference

Canonical product nouns. Style product nouns and config in Roobert Mono (per brand-guidelines). Full definitions + say-this/not-that: `references/glossary.md`.

| Noun | One line |
| --- | --- |
| **Project** | A git repo that *is* the company — config + accumulated state, all text. |
| **Session** | One unit of agent work, in its own sandbox on its own branch. |
| **Sandbox** | The disposable, microVM-isolated Linux machine a session runs in. |
| **Change request** | The reviewed merge toward `main`; how work lands and the company self-improves. |
| **Agent** | A markdown persona with a scoped reach into tools. Installable; can rewrite itself. |
| **Skill** | Reusable know-how for how the company does a job; rides into every session. |
| **Connector** | One-click reach into 3,000+ apps (plus MCP/OpenAPI/GraphQL/HTTP) through one scoped token. |
| **Secret** | Encrypted, scoped credential injected into sandboxes at runtime, never shown to the model. |
| **Channel** | A chat surface (Slack, Teams, Telegram, WhatsApp, SMS, email) that starts sessions where people already are. |
| **Trigger** | Cron or signed webhook that spawns sessions automatically. |
| **Memory** | The living company brain — files today, a system that compounds what it learns. |
| **App** | A declarative, durable deployment defined in config. |
| **`kortix.toml`** | The Kortix layer: sandbox image, triggers, channels, connectors, required secrets. |

## Approved wording — don't say / prefer

| Don't say | Prefer | Why |
| --- | --- | --- |
| AI agent platform | Autonomous Company Operating System | A category, not a feature. |
| Workflow automation / automation tool | A cloud computer where AI agents run your company | Not a zap — a computer that runs the company. |
| Chatbot / chat box | Command center; a workforce that produces real output | Real deliverables, not chat. |
| AI assistant / copilot | A workforce of AI agents | Org-scale and parallel, not one helper. |
| Users | People / your team / members (humans **and** agents are principals) | Matches the permissions model. |
| Plugins / extensions | Connectors | The canonical noun. |
| Integrations (as the headline noun) | Connectors (noun); "connect" (verb) | Keep the noun consistent. |
| Black box / magic | Everything is code you own — `grep` your whole company | Auditable, not hidden. |
| Deploy (an agent's output) | Open a change request; ship | Work lands through a reviewed merge to `main`. |
| No-code | Feels as simple as chat, with code underneath | Depth under the surface, not a ceiling. |
| Vendor / we host your AI | Open, self-hostable, yours down to the metal | We don't rent your company back to you. |
| seamless · revolutionary · unlock productivity · next-gen · AI-powered magic · transformative | a concrete mechanism | Banned hype (brand-guidelines voice). |

## Voice

- Direct and product-grounded. Lead with the mechanism and real product proof, not abstract AI claims.
- Concrete nouns: sessions, repos, sandboxes, change requests, connectors — not "solutions" or "capabilities."
- One audience per sentence.
- Confident, not breathless. The product is the proof; let it carry the line.
- Never imply unverified claims (autonomous deployment, certifications, customer names, metrics). Sanctioned proof points only — see `references/messaging.md`.
- Banned: the hype words in the table above.

## Audiences

One line each; full pitches (pain → promise → proof → sanctioned phrases → what not to say) in `references/pitches.md`.

- **Developers** *(primary)* — a managed cloud for OpenCode, Claude, and Codex agents. `kortix init`, `kortix ship`. Bring the subscription you already pay for; run background coding agents with a preview per change.
- **Companies** *(primary)* — a workforce you can actually manage, reachable from web, Slack, or Teams, on infrastructure where the data, config, and model belong to you.
- **Enterprise** *(primary)* — built to survive a security review: microVM isolation, real members/groups/roles, per-resource permissions, a secrets manager, audit trail, human approval gates, on-prem/VPC/air-gapped.
- **Agencies & consultancies** *(bonus)* — one horizontal platform sold through verticalized partners with their own front ends and starter templates. A franchise for the part of the economy about to be rebuilt.

## Pre-flight copy checklist

Before shipping any Kortix copy:

- [ ] Positioning matches the hierarchy — the right line for the surface.
- [ ] No banned word from the don't-say / prefer table.
- [ ] Product nouns are the canonical ones, styled per `references/glossary.md`.
- [ ] Every claim traces to a sanctioned proof point in `references/messaging.md` — nothing invented.
- [ ] One audience per sentence; the audience matches its pitch in `references/pitches.md`.
- [ ] Paired with `../brand-guidelines/SKILL.md` if the copy ships inside an asset.
- [ ] Any conflict with this skill flagged, with an on-message alternative offered.
