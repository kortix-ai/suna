---
name: comms
description: Use when writing or reviewing any Kortix-facing words — headlines, taglines, elevator pitches, audience pitches (developers, companies, enterprise), captions, deck or social copy, product naming, README or docs copy, or text composited into images — or when another skill needs Kortix's canonical positioning, terminology, or approved wording. The single verbal source of truth; pair with brand-guidelines for visuals.
---

# Kortix Comms

The **verbal source of truth** for Kortix. `brand-guidelines` governs how Kortix *looks*; this
skill governs what Kortix *says* — positioning, terminology, narrative, audience pitches, and
approved wording. Everything is in this one file. There are no companion reference documents.

Read this before writing any Kortix-facing words: a headline, tagline, pitch, caption, deck slide,
social post, product name, README section, or text composited into an image. When generating
assets, pair it with `../brand-guidelines/SKILL.md`.

Every fact here traces to `MANIFESTO.md` and `README.md` at the repo root. No invented metrics, customers,
or claims. If a request conflicts with this skill, flag the conflict and offer the closest
on-message alternative — the same discipline brand-guidelines uses for visuals.

---

## 1 · Positioning hierarchy

Four sanctioned lines. Each has one job — don't swap them.

| Layer | Line | Use for |
| --- | --- | --- |
| **Category** | AI Management System | What Kortix *is*. The default noun everywhere. |
| **Tagline** | The open-source AI Management System | Headlines, hero, site, README. The default lead. |
| **Comparative** | The open-source alternative to Claude Cowork and ChatGPT Work | Search, social, launch, GitHub. Anchors against the known category. |
| **Manifesto line** | A company is going to be a git repository | The deep thesis. Manifesto, vision talks, founder voice. |

**One-line what-is:** Kortix is the open-source AI Management System — your agents, their skills,
your company memory, and every connector in one git repo you own, with the agents working on real
cloud computers.

**Retired:** "Autonomous Company Operating System." Do not reintroduce it. "AI Management System"
replaced it because it names the job rather than claiming a category, and a cold reader needs no
explanation.

### The three lengths

- **Short (≤140 chars — GitHub About, meta description):** Open-source AI Management System —
  command your agents, skills, memory, and connectors from one repo you own. Any model. Self-host
  or cloud.
- **Standard (~30 words — README subtitle, landing sub):** Kortix is an open-source AI Management
  System — your agents, skills, company memory, and connectors in one git repo you own. Any model,
  your keys, self-hosted or managed cloud.
- **Long (~70 words — press, docs, about):** Agents that deliver finished work are now a product
  category. Every version of it runs inside a model lab, on that lab's model, with your company's
  brain on their side of the wall. Kortix is the one you own: an open-source AI Management System
  where your agents, skills, memory, and connectors live in one git repo, and the agents work on
  real cloud computers, landing work through a change request a human approves.

---

## 2 · What it is, the problem, why now

**What it is.** One place to run an AI-native company. Your agents, skills, connectors, secrets,
channels, triggers, and memory live in one repo that *is* the company — versioned, diffable, owned
outright. It feels as simple as a chat app; underneath, everything is code you own.

**The problem it solves.** The models got good — but every session they wake up with no memory of
you, your company, or your decisions. The tools built to fix that are demos: single-tenant, no
isolation, no version history, no permissions, no security story. The only alternative is renting
your company back from a model lab that keeps your data, config, and model. *A toy or a cage.*
Kortix refuses both.

**Why now.** Reasoning is solved; memory, isolation, permissions, and ownership are not. Running a
real AI workforce — thousands of isolated cloud computers on one config, each feeding reviewed work
back to `main` — is the unsolved part, and it's what Kortix is built for.

### Mission & vision

- **Mission:** Take a company from human to AGI — and let it keep every byte of itself on the way there.
- **Vision:** A company is a git repository — thousands of agents on one config, each isolated,
  pushing work into a `main` branch that never stops running and keeps improving itself. CI/CD for
  the work of an organization, not just its code.

---

## 3 · Product narrative (the arc)

1. **A company is a git repository.** A Kortix project is a git repo, and the repo *is* the
   company — configuration and accumulated state in one place, all text, all under version control,
   readable by a person and editable by an agent. `kortix.yaml` is the Kortix layer; the OpenCode
   config is the runtime agents think in. Everything past that is files. You can `grep` your entire
   company.
2. **It ships like code.** `kortix init` turns any directory into a Kortix; `kortix ship` checks it
   compiles, asks for missing secrets, pushes it up, and runs it. The repo behaves the same on your
   laptop as in the cloud.
3. **Work runs on cloud computers.** Start a session and a sandbox boots from one snapshot running
   the `kortix-sandbox-agent-server` daemon: it clones the repo, cuts a fresh branch, and hands you
   a ready machine. The agent works fully walled off; when it wants to keep something, it commits
   and opens a change request back toward `main`, and a human decides whether it lands.
4. **It scales to a workforce.** Because each session is its own sandbox on its own branch, you can
   run thousands in parallel without them touching each other. The only genuinely shared thing is
   the world outside. This parallel, isolated workforce is the part nobody else has.
5. **It improves itself.** `main` is always up. Triggers fire in the night. Any agent can edit its
   own configuration and propose the change, so the company files patches against itself.
6. **It feels easy.** Anyone can open it day one from the web, their phone, or a Slack thread. Most
   people never see a `kortix.yaml`. Click or edit a file — identical change.

### Message house

- **Category:** AI Management System.
- **Roof (promise):** Run your whole company from one place you own — a workforce of AI agents that does real work.
- **Four pillars:**
  1. **Open & yours.** Open source and self-hostable — your data, your models, your infrastructure. No lock-in, fully auditable.
  2. **A workforce, not one assistant.** Org-scale specialist agents that run in parallel and compound a shared memory.
  3. **Real work, not chat.** Agents run on real cloud computers and return finished deliverables — and take real actions in your tools.
  4. **Everything is code.** Versioned, reviewable, portable, governable — never a black box.

---

## 4 · Sanctioned proof points

Use these; don't invent others.

- 3,000+ apps connectable in a click, plus MCP, OpenAPI, GraphQL, and raw HTTP — brokered server-side through one scoped token.
- One isolated sandbox per session. **Do NOT claim blanket "microVM isolation"** — that is true for the Platinum provider (Cloud Hypervisor) but NOT for Daytona, which is the default and uses containers. Name microVM only where the provider is Platinum.
- **Do NOT claim "egress controlled at the network"** in the sense of BLOCKING traffic. Kortix does not allow-list or block a sandbox's outbound traffic; E2B ships `allowInternetAccess: true` and that design doc is still "Proposed — not scheduled". Removed 2026-07-31, and explicitly out of scope in `docs/specs/2026-08-19-secrets-exposure-usage-model.md` §9. What IS implemented, and is a different claim, is **egress-enforced SECRETS**: the sandbox holds a handle, Kortix substitutes the real credential outside the sandbox and only for exact approved HTTPS hosts. Say "the credential is enforced at the network boundary", never "the network is locked down".
- Thousands of agents in parallel on the same config, each on its own isolated cloud computer.
- Every session in its own disposable Linux sandbox on its own branch; work reaches `main` only through an approved change request.
- A real account/user/group model with per-resource permissions for people and agents; encrypted secrets injected at runtime; a full audit trail; human approval gates; on-prem or VPC deployment.
- **Secrets, stated precisely.** A secret has an EXPOSURE, and the claim depends on which one. **Egress-enforced** (the default): the sandbox holds a self-describing handle, the real value is substituted outside the sandbox for exact approved HTTPS hosts, and an echoed credential comes back `[REDACTED]` — here "the agent never holds the credential" is accurate. **Environment**: the value *is* a real env value that any command the agent runs can read — never write "never visible to the model" for this one (see `docs/specs/2026-08-19-secrets-exposure-usage-model.md`); it is required for credentials that are computed with rather than sent (SigV4, HMAC, JWT assertions, SSH keys). **None**: connector and LLM-gateway credentials, brokered server-side, never in the sandbox. Never present "network boundary" and "HTTPS broker" as two product choices — there is one mechanism. Scope is per project + per agent grant + connector scope; "per person / per group" was retired by migration `20260706_secrets_v2_identifier_model.sql`.
- **Approval gates are OFF by default** (`policy.default_mode` falls back to `allow_all`). Say "set this explicitly", never "it is on".
- **SSO is SAML 2.0 only** — no enterprise OIDC. Never write "SAML/OIDC". SCIM 2.0 is first-party but pages beyond the first are unimplemented.
- **Merge is default-deny for agents, not human-only.** An admin can grant `project.cr.merge`. Say the grant lives in `kortix.yaml` and cannot be widened without an approved change — do not say "only a human can merge".
- **"Air-gapped" is not a self-host capability today.** `kortix self-host start` pulls images from docker.io and reaches a sandbox provider over egress. Route isolated topologies to Enterprise.
- Bring your own models — any provider, your own keys — or the ChatGPT, Claude, or Cursor subscription you already pay for.
- Open source and self-hostable; runs on Kortix Cloud, your servers, or fully on-prem.
- Three ways work runs: on-demand, human-assisted, and automated.
- 20,000+ GitHub stars on `kortix-ai/suna`. Cite the number, never "the go-to" or "the leading."

### Sanctioned analogies

Use sparingly and only as stated. Don't stack multiple analogies in one breath.

- "CI/CD, but for the work of an organization, not just its code."
- "A company you can clone."
- "The WordPress of AGI" — one open core platform you own and extend.

---

## 5 · The competitors

Kortix is positioned against the finished-work agent category. Get these facts right — naming a
competitor's product wrong is an instant credibility hit.

| | Claude Cowork | ChatGPT Work |
| --- | --- | --- |
| **Vendor** | Anthropic | OpenAI |
| **Shipped** | Desktop January 2026; web + mobile 2026-07-07 | 2026-07-09 |
| **Access** | Paid plans — Pro, Max, Team, Enterprise | Paid plans, usage-metered |
| **Model** | Anthropic models only | GPT-5.6 only |
| **Hosting** | Anthropic's cloud, or the customer's Amazon Bedrock / Google Cloud / Microsoft Foundry account. No self-host. | OpenAI's cloud, no self-host |

- The product is **Claude Cowork** — lowercase `w`, one word. **There is no "Claude Work."**
- **ChatGPT Work** is two words, both capitalized.
- Only claim what is publicly documented. Do **not** claim anything about their concurrency,
  parallelism, or session limits — we have no verified data on either.
- **Cowork is not Max-only, and it is not Anthropic-cloud-only.** Verified 2026-07-31 against
  `claude.com/pricing` (Pro: "Includes Claude Cowork"; Team: "Includes Claude Code and Claude
  Cowork") and `claude.com/product/cowork` ("Runs where your data lives: Use a Claude account or
  your own cloud provider: Amazon Bedrock, Google Cloud, or Microsoft Foundry"). Both older claims
  were wrong and are corrected above.
- The comparison in `README.md` is the canonical version. Keep any other comparison consistent with
  it, and re-check it whenever either product changes.

---

## 6 · Glossary — canonical terms

Style product nouns and config tokens in Roobert Mono (per brand-guidelines). Use these spellings
exactly.

### Brand names

- **Kortix** — the company and the platform. Lead with this everywhere.
- **Suna** — the open-source repository the platform lives in (`kortix-ai/suna`). In outward copy, prefer **Kortix** alone unless you specifically mean the repo.
- **Kortix Cloud** — the managed hosting. Capitalize both words.
- **Platinum.dev** — the compute floor under the platform (CPU/GPU sandboxes, inference, training). Lowercase `.dev`.

### Core objects

- **Project** — a git repo that *is* the company: configuration plus accumulated state, all text, all version-controlled. Not "workspace" or "account."
  - Say: "your project is a repo you own." Not: "your workspace in our cloud."
- **`kortix.yaml`** — the Kortix layer of a project: sandbox image, cron/webhook triggers, channels, connectors, required secrets, and where agent config lives. Mono.
- **OpenCode config** — the runtime agents think in: agents, skills, commands, tools, plugins, models, providers.
- **Session** — one unit of agent work, running on its own cloud computer on its own branch, owned by whoever or whatever started it. Not "chat," "thread," or "conversation."
  - Say: "start a session." Not: "open a chat."
- **Cloud computer / sandbox** — the disposable, isolated Linux machine a session runs on. Use **cloud computer** when the point is that agents work on a real machine; use **sandbox** when the point is isolation. Both are sanctioned; never say "container" in external copy. Do not write "microVM" here — see §4; that holds for Platinum only.
- **`kortix-sandbox-agent-server`** — the daemon a sandbox boots with: clones the repo, cuts the branch, loads config into a live runtime, and exposes prompting/streaming/files/terminal. Mono. Mostly internal.
- **Change request** — the reviewed merge back toward `main`; how work lands and how the company self-improves. CLI: `kortix cr`. Behaves like a pull request, but in product copy say "change request."
  - Say: "the agent opens a change request you approve." Not: "the agent deploys."

### The pieces you work with

- **Agent** — a markdown persona with a prompt and a tightly scoped reach into tools and resources. Installable in one click; can rewrite itself. Not "bot."
- **Skill** — markdown plus scripts that encode how the company does a specific job; lives in the repo and rides into every session. The part that compounds.
- **Connector** — one-click reach into 3,000+ apps, plus MCP, OpenAPI, GraphQL, and raw HTTP, brokered server-side through one scoped token. Noun = "connector"; verb = "connect." Not "plugin" or "integration."
- **Secret** — an encrypted, per-project credential delivered to a session under one of three EXPOSURES: `egress-enforced` (default — the sandbox holds a handle; Kortix substitutes the real value outside the sandbox for exact approved HTTPS hosts), `environment` (the real value in an env var, readable by any command the agent runs — **never claim it is hidden from the model**, see `docs/specs/2026-08-19-secrets-exposure-usage-model.md`), and `none` (spent only by a Kortix service, such as a connector or the LLM gateway; never enters the machine). Say "exposure", not "delivery mode", and never present a boundary-vs-broker choice. **Never claim that Kortix blocks a sandbox's egress** — enforcing where a CREDENTIAL may go is not the same as controlling where the sandbox may connect, and only the first is implemented.
- **Channel** — a chat surface where a bot starts sessions where people already are. The manifest enum is CLOSED: `slack`, `teams`, `email`, `voice` (`packages/manifest-schema/src/constants.ts` → `CHANNEL_PLATFORMS`). Only **Slack** is live; **Teams** is behind an operator switch (`TEAMS_CHANNEL_ENABLED` defaults false); **email** and **voice** are experimental (`platformDefault: () => false`). **Telegram, WhatsApp, SMS and Discord are NOT channels** — do not list them. Do not claim "one click": install needs Slack OAuth env, and the bot must still be invited and @-mentioned.
- **Trigger** — a cron schedule or signed webhook that spawns sessions automatically.
- **Memory** — the living company brain: plain files today, a system that compounds what it learns over time. In external copy, not "vector database."

### How work runs (three modes)

- **On-demand** — ask in chat, get it now.
- **Human-assisted** — the agent works and checks in for the calls that matter.
- **Automated** — runs on a schedule or trigger, end to end.

### Capitalization & style

- **Kortix**, **Suna**, **Kortix Cloud**, **Platinum.dev**, **Claude Cowork**, **ChatGPT Work** — exactly as written.
- Product objects (project, session, sandbox, cloud computer, agent, skill, connector, secret, channel, trigger, memory, change request) are common nouns — lowercase in prose, capitalized only at sentence start or as table/UI labels.
- **AI Management System** is capitalized as a category name.
- Config tokens and commands in Roobert Mono: `kortix.yaml`, `kortix init`, `kortix ship`, `kortix cr`, `main`.
- "git repository" / "repo," "`main` branch," "change request" — lowercase.

---

## 7 · Approved wording — don't say / prefer

| Don't say | Prefer | Why |
| --- | --- | --- |
| Autonomous Company Operating System | AI Management System | Retired category line. |
| AI agent platform | AI Management System | A category, not a feature. |
| Claude Work | Claude Cowork | The product does not exist under that name. |
| Workflow automation / automation tool | An AI Management System you own | Not a zap — a system that runs the company. |
| Chatbot / chat box | Command center; a workforce that produces real output | Real deliverables, not chat. |
| AI assistant / copilot | A workforce of AI agents | Org-scale and parallel, not one helper. |
| Container / VM (external copy) | Cloud computer; sandbox | The sanctioned nouns. |
| Users | People / your team / members (humans **and** agents are principals) | Matches the permissions model. |
| Plugins / extensions | Connectors | The canonical noun. |
| Integrations (as the headline noun) | Connectors (noun); "connect" (verb) | Keep the noun consistent. |
| Black box / magic | Everything is code you own — `grep` your whole company | Auditable, not hidden. |
| Deploy (an agent's output) | Open a change request; ship | Work lands through a reviewed merge to `main`. |
| No-code | Feels as simple as chat, with code underneath | Depth under the surface, not a ceiling. |
| Vendor / we host your AI | Open, self-hostable, yours down to the metal | We don't rent your company back to you. |
| The go-to / #1 / the best | 20,000+ GitHub stars | State the fact, not the superlative. |
| *(exception)* | **"the leading open-source alternative"** IS sanctioned — decided 2026-07-31 and used in the hero. It rests on the star count; cite that if challenged. No other superlative is allowed, and never extend it to "the best" or "#1". |
| Source-available; Elastic License; Apache 2.0; MIT | open source (and stop there) | Never name a license in public copy. |
| more powerful · fully extensible · seamless · revolutionary · unlock productivity · next-gen · AI-powered magic · transformative | a concrete mechanism | Banned hype. |

**On the license:** Kortix ships under the Elastic License. In any public-facing copy say
**"open source"** and stop. Do not name a license, do not add a license badge. "Developed in the
open," "code you can read, fork, and audit," and "self-host for free" are accurate and fine.

---

## 8 · Voice

- Direct and product-grounded. Lead with the mechanism and real product proof, not abstract AI claims.
- Concrete nouns: sessions, repos, cloud computers, sandboxes, change requests, connectors — not "solutions" or "capabilities."
- One idea per sentence. One audience per sentence.
- Confident, not breathless. The product is the proof; let it carry the line.
- Never imply unverified claims (autonomous deployment, certifications, customer names, metrics). Sanctioned proof points only.
- Never name a customer. Codenames only.
- Banned: the hype words in the table above.

---

## 9 · Audiences

Each pitch: **who → pain → promise → proof/mechanism → sanctioned phrases → what not to say.**

### Developers *(primary)*

- **Who:** Engineers already running coding agents who want them in the cloud, in the background, with state that sticks.
- **Pain:** Agents stuck on one laptop; no shared state, no isolation, no preview per change; every tool wants its own setup.
- **Promise:** A managed cloud for your coding agents. One `kortix.yaml`, one config, one repo for the state that sticks.
- **Proof / mechanism:** `kortix init`, `kortix ship` — that's the loop. Every change request gets a preview you can open. Have your local agent spin up cloud sessions and go wide. Bring the subscription you already pay for.
- **Sanctioned phrases:** "managed cloud for your coding agents," "background agents with a preview per change," "one repo for the state that sticks," "bring your own subscription."
- **Don't say:** "replaces your IDE," "no more code," or anything implying autonomous merge without review — work lands via change request.

### Companies *(primary)*

- **Who:** Teams that want AI doing real work across the business, reachable where people already are.
- **Pain:** Forty disconnected tools; AI that forgets context; output that's chat, not finished work; vendors holding the data.
- **Promise:** A workforce you can actually manage. People talk to it through the web, Slack, or Teams. It picks up the business as it goes.
- **Proof / mechanism:** Agents run on real cloud computers and return finished deliverables (decks, reports, code, replies) and take real actions in your tools; work runs on-demand, human-assisted, or automated; the data, config, and model belong to the company.
- **Sanctioned phrases:** "a workforce, not one assistant," "real work, not chat," "run your company from one place you own."
- **Don't say:** "fully autonomous company" (humans approve change requests), invented productivity metrics, or customer names.

### Enterprise *(primary)*

- **Who:** Security, IT, and platform leaders who must put AI in front of a security review.
- **Pain:** AI tools that fold under a security review — no isolation, no permissions, no audit, no on-prem story.
- **Promise:** Built to survive a security review, not slip past one.
- **Proof / mechanism:** one isolated machine per session (microVM on Platinum, containers by default — say which); members, groups, and roles that match your org; per-resource permissions for people **and** agents; a secrets manager; full audit trail; approval gates (off by default — say so); your own VPC or on-prem network. **Not air-gapped:** `self-host start` pulls images from docker.io.
- **Sanctioned phrases:** "survives a security review," "isolation, permissions, audit, approval gates," "your data, your models, your infrastructure — no lock-in."
- **Don't say:** "certified" or specific compliance claims (SOC 2, ISO, etc.) unless given as fact; "unbreakable" / "100% secure."

### Agencies & consultancies *(bonus)*

- **Who:** Firms bringing AI into their clients who need a platform to bet on.
- **Pain:** Rebuilding the same AI plumbing per client; no durable platform; reselling someone else's locked box.
- **Promise:** One horizontal platform sold through verticalized partners with their own front ends and their own starter templates.
- **Proof / mechanism:** Partners handle distribution and clients; Kortix provides the technology, the training, and the playbook. Importable projects, agents, and skills via the marketplace.
- **Sanctioned phrases:** "one horizontal platform, verticalized partners," "the technology, the training, and the playbook," "a franchise for the AI rebuild."
- **Don't say:** specific revenue-share or partner terms unless given as fact.

---

## 10 · Business model *(context, not external copy)*

Open source and self-hostable underneath; a cloud charging for seats and compute; single-tenant
deployments for those who must self-run; a marketplace of agents, skills, and importable projects;
and **Platinum.dev**, the compute floor (CPU/GPU sandboxes, inference, training). The platform
proves itself by running Kortix's own companies in public.

---

## 11 · Pre-flight copy checklist

- [ ] Positioning matches the hierarchy in §1 — the right line for the surface.
- [ ] No banned word from the §7 don't-say / prefer table.
- [ ] Product nouns are the canonical ones from §6, styled correctly.
- [ ] Every claim traces to a sanctioned proof point in §4 — nothing invented.
- [ ] Any competitor named is spelled and described per §5, with no unverified claims.
- [ ] "open source" used; no license named.
- [ ] One audience per sentence; the audience matches its pitch in §9.
- [ ] Paired with `../brand-guidelines/SKILL.md` if the copy ships inside an asset.
- [ ] Any conflict with this skill flagged, with an on-message alternative offered.
