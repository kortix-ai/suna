# Kortix Messaging — Narrative Source of Truth

Deep-dive companion to `../SKILL.md`. Everything here traces to `suna/MANIFESTO.md` and `suna/README.md`. No invented facts, metrics, customers, or claims.

## Mission

Take a company from human to AGI — and let it keep every byte of itself on the way there.

## Vision

A company is going to be a git repository. Not a metaphor — literally something you can clone: its agents, the skills it has built up, the way it actually does its work, every fact it has learned, and the definition of the machines all of that runs on. Versioned, diffable, owned outright. Thousands of agents on one config, each isolated, pushing work into a `main` branch that never stops running and keeps improving itself — the equivalent of CI/CD, but for the work of an organization instead of just its code.

## Why now

The models got good — that part is over. Hand one a hard problem and it reasons through it better than most people you've worked with. What it can't do is remember you exist: every session it wakes with no idea who you are, what you're building, or what you decided last Tuesday. Brilliant, and with no past. Reasoning is solved; memory, isolation, permissions, and ownership are not.

## The problem: a toy or a cage

Two options on the table today, both bad:

- **A toy.** Tools built to give models a past are demos — single-tenant, one machine, no isolation, no version history, no permissions worth the name, no security story beyond "trust us." You can't run forty at once, can't see what changed and roll it back, can't put one in front of an enterprise security team. Gorgeous in a launch video; they fold the moment a business leans its weight on them.
- **A cage.** Crawl back to the model labs, who host the polished version and keep your data, configuration, and model on their side of the wall — where it stays theirs and you rent access to your own operation forever.

Kortix is what you build when you refuse both.

## Product narrative (the arc)

1. **A company is a git repository.** A Kortix project is a git repo, and the repo *is* the company — configuration and accumulated state in one place, all text, all under version control, readable by a person and editable by an agent. Two files define it: `kortix.toml` (the Kortix layer) and the OpenCode config (the runtime agents think in). Everything past that is files. You can `grep` your entire company.
2. **It ships like code.** `kortix init` turns any directory into a Kortix; `kortix ship` checks it compiles, asks for missing secrets, pushes it up, and runs it. The repo behaves the same on your laptop as in the cloud. Local dev and the live system stop being different categories.
3. **Work runs in isolated sessions.** Start a session and a sandbox boots from one snapshot running the `kortix-sandbox-agent-server` daemon: it clones the repo, cuts a fresh branch, and hands you a ready machine. The agent works fully walled off; when it wants to keep something, it commits and opens a change request back toward `main`, and a human decides whether it lands.
4. **It scales to a workforce.** Because each session is its own sandbox on its own branch, you can run thousands in parallel without them touching each other — fifty coding agents, fifty doing outreach. The only genuinely shared thing is the world outside. This parallel, isolated workforce is the part nobody else has.
5. **It improves itself.** `main` is always up. Triggers fire in the night. Any agent can edit its own configuration and propose the change, so the company files patches against itself — all tracked — and gets better at being a company over time instead of freezing on the day you set it up.
6. **It feels easy.** Anyone can open it day one from the web, their phone, or a Slack thread, like any chat app. Most people never see a `kortix.toml`. The interface and the code are the same system from two angles — click or edit a file, identical change.

## Message house

- **Category:** Autonomous Company Operating System.
- **Roof (promise):** Run your whole company from one place you own — a workforce of AI agents that does real work.
- **Four pillars** (from README):
  1. **Open & yours.** Open source and self-hostable — your data, your models, your infrastructure. No lock-in, fully auditable.
  2. **A workforce, not one assistant.** Org-scale specialist agents that run in parallel and compound a shared memory.
  3. **Real work, not chat.** Agents run on real computers and return finished deliverables — and take real actions in your tools.
  4. **Everything is code.** Versioned, reviewable, portable, governable — never a black box.
- **Foundation (proof):** the sanctioned proof points below.

## Sanctioned proof points

Use these; don't invent others.

- 3,000+ apps connectable in a click, plus MCP, OpenAPI, GraphQL, and raw HTTP — brokered server-side through one scoped token.
- microVM isolation; egress and credentials controlled at the network.
- Thousands of agents in parallel on the same config, each fully isolated.
- Every session in its own disposable Linux sandbox on its own branch; work reaches `main` only through an approved change request.
- A real account/user/group model with per-resource permissions for people and agents; a secrets manager (encrypted, injected at runtime, never exposed); a full audit trail; human approval gates; on-prem, VPC, or air-gapped deployment.
- Bring your own models — any provider, your own keys — or the ChatGPT, Claude, or Cursor subscription you already pay for.
- Open source and self-hostable; runs on Kortix Cloud, your servers, or fully on-prem.
- Three ways work runs: on-demand, human-assisted, and automated.

## Sanctioned analogies

Use sparingly and only as stated. Don't stack multiple analogies in one breath.

- "The WordPress of AGI" — one open core platform you own and extend.
- "CI/CD, but for the work of an organization, not just its code."
- "A company you can clone."

## Business model (context, not external copy)

Open source and self-hostable underneath; a cloud charging for seats and compute; single-tenant deployments for those who must self-run; a marketplace of agents, skills, and importable projects; and **Platinum.dev**, the compute floor (CPU/GPU sandboxes, inference, training). The platform proves itself by running Kortix's own companies in public.
