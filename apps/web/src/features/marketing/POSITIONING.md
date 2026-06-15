# Kortix — Positioning & Messaging (source of truth)

> One file. The brand bible. Every landing section, SEO page, compare page and
> blog post is generated/edited against this. If copy contradicts this doc, this
> doc wins. Humans and agents both read this before writing marketing copy.

---

## The one-liner

**The open-source AI workforce platform.** Give every employee an AI coworker —
one that connects to all your tools, ships real work, and gets smarter every
time someone shares how they work. Yours to own and self-host.

## Category

Open-source AI workforce platform. (Not "an AI assistant." Not "a chatbot." A
**workforce** your company owns and levels up.)

## Who it's for — layered audience

1. **Companies (primary — top of every page).** Exec / ops / founder / IT leaders
   who want *every* employee to be an AI power user. They feel the outcome.
2. **Builders & developers (secondary — dedicated `/developers` page).** The
   platform is Git-backed, CLI-first, multi-model, MCP-native, self-hostable.
   The tech is the moat — give it its own home, don't dilute the main page with it.

## The three pillars (why Kortix)

1. **A workforce, not a chatbot.** Every employee gets AI coworkers that connect
   to 3,000+ tools and ship *real output* — decks, dashboards, web apps, code,
   campaigns — across Slack, web, mobile and API. (Table stakes vs. Viktor/ChatGPT.)
2. **Skillify your company.** Package how your best people work into versioned,
   shareable, *composable* skills — dependency-based, like packages. One person
   adds it → the whole company inherits it. The floor rises with every share.
   **(This is the differentiator. Lead with it.)**
3. **Own it, don't rent it.** Open-source, self-hostable, bring any model, no
   lock-in. Your data, your agents, your infra. **(This is the wedge vs. everyone.)**

> For builders, add a 4th: **a real platform underneath** — the Git repo is the
> source of truth; CLI, sandboxes, a multi-model gateway, MCP/HTTP/OpenAPI
> connectors. Belongs on `/developers`.

## The wedge in one breath

Everyone else *rents* you a closed AI assistant. Kortix is the AI workforce your
whole company **builds, shares as skills, and owns.**

## Positioning statement (classic format)

For companies that want every employee to be an AI power user, **Kortix** is the
**open-source AI workforce platform** that gives everyone AI coworkers connected
to all their tools. Unlike closed assistants you rent (ChatGPT, Viktor, Glass),
Kortix is yours to **own, self-host, and continuously level up by sharing skills**
across the company.

## Voice (locked)

Confident, punchy, declarative. **2–5 word section headlines.** Crisp,
benefit-led body — never an essay. Lead with outcomes and proof (the demo, real
outputs, the tool count, the comparison). Manifesto energy in the big lines
(hero / problem / closing); product clarity everywhere else. No fluff. Say the
sharp thing.

Reference cadence (the rhythm we want): "Not a tool. A hire." / "Real output,
not just text." / "One message, all your tools." — ours, but truer and plural.

## Proof we lean on

- Open-source (GitHub stars), self-hostable, SOC 2 (in progress — **always say
  "in progress," never "certified"** until the report lands).
- 3,000+ integrations (Pipedream + MCP/HTTP/OpenAPI/GraphQL).
- Real outputs: PDFs, dashboards, web apps, code & PRs.
- Multi-surface: Slack, web, mobile, API, CLI.
- Multi-model: any provider, bring your own key/subscription.

## Comparison one-liners (for `/compare/*` pages)

- **vs ChatGPT / Claude:** "They answer questions. Kortix ships the work — and you own it."
- **vs Viktor / closed AI employees:** "One rented hire vs. a whole workforce you own and skill up."
- **vs Zapier / workflow tools:** "Rules you write and maintain vs. agents that figure it out."
- **vs DIY agents (OpenClaw / build-your-own):** "Production-ready and ownable — without the maintenance treadmill."
- **vs Claude/ChatGPT in Slack:** "A chat in Slack vs. a coworker that ships real work in Slack."

## Words we use / avoid

- USE: AI coworker, AI workforce, skill, skillify, own, self-host, ships, real work, the whole company.
- AVOID: "chatbot," "copilot," "assistant" (for us), "magic," "revolutionary," hype.

## Page system (SEO architecture — what the agents maintain)

All generated from this doc. Layout = React templates; agents write **content**, not layout.

- `/` — main landing (conversion + narrative blend; see motion below)
- `/developers` — the platform/tech showcase (dev audience)
- `/skills` (a.k.a. Dojo) — the skills marketplace; `/skills/[slug]` per-skill SEO pages
- `/integrations` — overview; `/integrations/[slug]` per-tool SEO pages ("AI agent for Salesforce")
- `/compare/kortix-vs-[competitor]` — chatgpt, viktor, zapier, claude-in-slack, openclaw, glass
- `/use-cases/[persona]` — founders, marketing, engineering, ops-finance, support
- `/blog/[slug]` — agent-written, SEO-optimized
- existing: `/pricing`, `/enterprise`, `/security`, `/templates`

### Landing motion (blends our narrative + Viktor's conversion machinery)

1. Hero — the one-liner + product demo + social-proof bar (logos · teams · free credits · SOC 2)
2. Problem — "The models are good enough. The harness isn't."
3. Real output — "Real work, not just answers." (PDFs / dashboards / apps / code)
4. All your tools — "One message, every tool." (3,000+)
5. **Skillify your company** — the differentiator (marketplace, dependency-based sharing)
6. Memory — "Never re-explain your company."
7. Always on — "It works while you don't." (schedules · Slack · headless)
8. Comparison — "You've tried AI tools. The work's still there." (table)
9. Use cases — by persona (founders / marketing / eng / ops)
10. Own it — open-source / self-host moat
11. Security — enterprise-ready, hosted on your terms
12. FAQ
13. Closing — "We don't lower the ceiling. We raise the floor." + pricing CTA
