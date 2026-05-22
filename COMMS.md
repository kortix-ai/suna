# Kortix — Communications & Messaging Source of Truth

> **This is the canonical answer to "what is Kortix?"** Everything else — the landing
> page, docs, decks, sales calls, tweets — should ladder up to this doc.
>
> ⚠️ **Supersedes** the positioning in `README.md` and `MANIFESTO.md` (both still describe
> an older "AI company of one / a computer with a brain" framing). Realign those to this.

---

## 1. The one-liner

> **Kortix is the AI command center for your company.**

**Category line (hero):** The AI command center for your company.

---

## 2. Say it in one breath (elevator pitch)

Kortix is where your company runs on AI. One place where all your context, agents,
triggers, integrations, and memory live — and a workforce of AI agents does the real
work across your tools, around the clock. It feels as simple as a chat app; underneath,
everything is code you own. Open, self-hostable, and enterprise-ready.

---

## 3. Boilerplate (copy-paste, by length)

- **5 words:** The AI command center.
- **10 words:** Kortix is the AI command center for your company.
- **25 words:** Kortix runs your company on AI — a workforce of agents that work across your tools and ship real results, in one place you control.
- **50 words:** Kortix is the AI command center for your company. Connect your tools, set up agents for every team, and they do the real work — on-demand, human-assisted, or fully automated — around the clock. Simple enough for anyone to use, open and self-hostable so you always stay in control.

---

## 4. What is Kortix? (the plain answer)

Kortix is the platform a company runs its AI on.

Most AI tools give you a chat box. Kortix gives you a **command center**: one place where
your agents, skills, integrations, automations, and memory all live — and a workforce of
AI agents that produces real output (decks, reports, code, replies, deployed work), not
just chat.

It is **not** a chatbot, a copilot, or a single "AI employee." It's the operating layer
for an AI-native company — accessible to anyone, owned by you.

---

## 5. What's in the command center (the primitives)

| | |
| --- | --- |
| **Agents** | Your AI coworkers — one per role or task. |
| **Skills & workflows** | Reusable know-how that does a job your way. |
| **Integrations** | 3,000+ tools, connected once and shared across the org. |
| **Chat & sessions** | Where you and your team work with agents, live. |
| **Automations** | Triggers on a schedule, a webhook, or a chat message. |
| **Memory** | A living company brain that compounds over time. |

(This set doubles as the product's left-nav, so the site and product stay consistent.)

---

## 6. How work runs (the spectrum)

Work happens three ways — Kortix does all three:

- **On-demand** — ask an agent in chat and get it done now.
- **Human-assisted** — the agent does the work and checks in for the calls that matter.
- **Automated** — runs on a schedule or trigger, end to end, hands-off.

---

## 7. Skills

A **skill** is a reusable way to do a specific job — the way your company does it. Teach
it once, build a library by department, and every agent can use it. Skills are how the
system gets better over time and how know-how is shared across teams.

---

## 8. What makes Kortix different

Said on our own terms — no comparisons needed:

1. **Open & yours.** Self-hostable; your data, your models, your infrastructure. No lock-in, fully auditable.
2. **A whole workforce, not one assistant.** Org-scale specialist agents that run in parallel and compound a shared memory.
3. **Real work, not chat.** Agents run on real computers and return finished deliverables — and take real actions in your tools.
4. **Everything is code.** Versioned, reviewable, portable, governable — never a black box. (The deep story lives on the Technology page.)

---

## 9. How a company rolls it out

1. **Set up your workspace** — create a project, invite your teams, set roles and access.
2. **Connect everything** — plug in the 3,000+ tools you already run.
3. **Build your agents** — turn your real processes into agents and skills that work your way.
4. **Roll out by department** — sales, finance, ops, support — and scale what works.

Live across a company in weeks, not a six-month implementation.

---

## 10. The technical layer (for builders / the Technology page)

Under the hood, **a Kortix project is a git repo** — the single source of truth for the
whole company. The flow:

- `kortix init` scaffolds the company as a repo (config, agents, skills, memory).
- `kortix.toml` declares triggers, channels, connectors, and the sandbox.
- `.opencode/` holds agents, skills, and commands as files you edit and ship like code.
- `kortix deploy` boots an isolated sandbox per session and runs it in the cloud (or self-host).
- Sessions run on their own git worktree; what's worth keeping is committed and **PR'd to
  `main` — a human approves**, so the company self-improves, one reviewed change at a time.

Engine- and provider-agnostic (built on [OpenCode](https://opencode.ai); BYO models or
Kortix cloud). **The landing stays code-free — this story belongs on `/technology`.**

---

## 11. Enterprise & security

- **Members, groups & roles** that match your org.
- **Permissions & scoping** for people *and* agents — every resource scoped.
- **Secrets** held securely and injected at runtime, never exposed.
- **On-prem, VPC, or air-gapped** — your data never leaves your perimeter.
- **Full audit trail** and **human approval gates** on sensitive actions.

---

## 12. Open & yours / deployment

- **Open and self-hostable** — laptop, a VPS, your VPC, or air-gapped.
- **Bring your own models** — your keys/subscription, or Kortix cloud compute.
- **No lock-in** — your agents, data, and workflows go where you go.
- **Build & resell** — agencies and builders ship their own solutions on top of Kortix.

---

## 13. Pricing & business model *(indicative)*

- **Open Source** — free to self-host, forever.
- **Cloud** — ~$20 / seat / month + usage-based compute. The Vercel model: we make money on cloud.
- **Enterprise** — custom: on-prem/VPC, SAML SSO & SCIM, advanced RBAC, audit, DPA, SLAs, dedicated support.
- Self-hosting is allowed as single-tenant for your own use (not as a competing public cloud).
- Later: a marketplace of importable, shadcn-style project templates.

---

## 14. The site

- **Nav:** Home · Use cases · Technology — plus **Get started** (primary CTA) and **Request demo** (secondary).
- **Home** (`/`) — business pitch: hero → scroll-through product tour (Business / Technical switch) → rollout → enterprise & open → CTA. Zero code talk.
- **Use cases** (`/use-cases`) — the agent library: searchable agents by industry, each opening a breakdown (video + how-it-works + inputs/outputs).
- **Technology** (`/technology`) — the git-native framework, in depth (the §10 story).
- **Pricing** (`/pricing`) — Open Source / Cloud / Enterprise + comparison.
- **Request demo** (`/enterprise`) — the sales contact form.
- **Get started** → `/auth`.

---

## 15. Go-to-market (how we win)

Positioning: the open platform companies build their AI on — the **WordPress / Shopify of
the AGI era**.

- **Win builders, consultants & solopreneurs** with the open, git-native platform.
- **Win agencies & consultancies as distribution** — they build on Kortix and sell it into companies.
- **Win enterprises** with the "own it" wedge: open + on your infrastructure.
- **Prove it by using it** — dogfood by running our own AI-led companies on Kortix.

---

## 16. Naming

- **Kortix** — the product and company. Use this everywhere in comms.
- **Suna** — the legacy/open-source name (repo: `github.com/kortix-ai/suna`). Avoid in new marketing copy.
- **OpenCode** — the open agent runtime Kortix builds on. Credit it; don't conflate it with Kortix.

---

## 17. Voice & vocabulary

**Words we use:** command center · AI company · workforce · agents · skills · integrations ·
automations · memory · deliverables · on-demand / human-assisted / automated · open ·
own your infrastructure · 24/7 · compounds.

**Words we avoid:** chatbot · copilot · "assistant" (for the product as a whole) ·
"AI employee" (singular). Keep **code/git talk off the landing** — it lives on the Technology page.

**Tone:** confident, clear, founder-grade. Sell the outcome (a company that runs itself);
keep the product *feel* as simple as a chat app even though it's deeply extensible.

**License wording:** say **"open" / "source-available"** — never "MIT" or "100% open source."

---

## 18. FAQ — the basics

**Is it a chatbot?** No. It's a workforce of agents that do real work and return finished
deliverables, on a real computer.

**Do I need to be technical?** No to use it (it should feel like a chat app). Yes if you
want to go deep — because everything is code.

**Can I self-host?** Yes — laptop, VPS, your VPC, or air-gapped. Bring your own models.

**How does pricing work?** Open-source is free to self-host. Cloud is per seat + usage.
Enterprise is custom with on-prem and advanced controls.

**What about security and oversight?** On-prem options, RBAC and scoping, a secrets
manager, full audit trail, and human approval gates on sensitive actions.

**Who is it for?** AI-native teams, enterprises that need to own their stack, and the
builders and agencies building AI businesses on top.

---

## 19. Open questions / TBD

- **Suna → Kortix naming:** confirm the public story (rename? sub-brand? sunset?).
- **Pricing:** confirm exact seat price and usage model before publishing numbers.
- **Realign `README.md` and `MANIFESTO.md`** to this positioning.
- **Wire `Request demo` (`/enterprise`)** to a CRM/endpoint (currently email-based).
