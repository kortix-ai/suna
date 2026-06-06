# Use-Cases Demo Section — Design Spec

**Date:** 2026-06-06
**Surface:** `apps/web` landing page (`/`)
**Status:** Approved, ready for implementation plan

## Goal

Add a new landing-page section — **"An agent for every job on your plate"** — that
showcases Kortix's cross-functional AI workforce as an interactive, vertically-tabbed
demo. A left tab-rail (icon + title + short description) selects one of six flagship
workflows; the right panel shows an eyebrow label, headline, paragraph, a static
terminal-style agent run-log, and a `Learn more →` link that deep-links into the
existing `/use-cases` pages.

It is the vertical-tab sibling of the existing "Work Loop" section
(`apps/web/src/app/(home)/page.tsx`, the `WORK_LOOPS` tabbed block) and reuses the
landing page's design language exactly.

## Positioning (per `internal-comms`)

- Section reinforces the tagline **"The AI command center for your company"** and the
  `/use-cases` line **"An agent for every job on your plate."**
- Copy uses canonical nouns: agents, sandboxes, change requests, `main`, audit trail,
  human review. No banned hype words.
- Run-log numbers are **illustrative demo content** (same convention as the existing
  homepage "morning brief" demo), not verified metrics. All *positioning* claims
  (microVM/sandbox isolation, change requests, audit trail, human approval) trace to
  sanctioned proof points.

## Decisions (locked)

| Decision | Choice |
| --- | --- |
| Content source | New curated landing-specific dataset (not the raw INDUSTRIES catalog) |
| Tab lineup | Cross-functional: Support, Engineering, Sales, Finance, Marketing, Ops |
| Agent run-log | Static lines (no streaming) |
| Learn more | Deep-link per tab into an existing `/use-cases/<slug>` page |
| Placement | Directly after the "Work Loop" section in `page.tsx` |

## Architecture

### Data — `apps/web/src/features/use-cases/landing-demos.ts` (new)

Landing-specific, kept separate from the industry catalog (`data.ts`) so neither
pollutes the other; the `learnMoreSlug` is the bridge into the existing pages.

```ts
import type { LucideIcon } from 'lucide-react';

export type LandingDemo = {
  id: string;
  icon: LucideIcon;          // tab-rail icon
  tabTitle: string;          // left rail title
  tabDescription: string;    // left rail one-liner
  eyebrow: string;           // right panel mono label
  title: string;             // right panel headline
  description: string;       // right panel paragraph
  log: string[];             // static terminal run-log lines
  learnMoreSlug: string;     // -> /use-cases/<slug>
};

export const LANDING_DEMOS: LandingDemo[] = [ /* 6 entries, see Content */ ];
```

Each `learnMoreSlug` MUST match a slug produced by `slugFor(industry, agent)` in
`data.ts`, so the link resolves to a real `/use-cases/[slug]` page.

### Component — `apps/web/src/components/home/use-case-showcase.tsx` (new)

`'use client'`. Holds `activeId` state (defaults to first demo). Renders the section
heading, the bordered card containing the rail + panel. Dropped into `page.tsx` as
`<UseCaseShowcase />` inside a `<Reveal>`-wrapped `<section>`.

One purpose, self-contained. Depends only on `LANDING_DEMOS`, the marketing `Button`,
`Eyebrow`/`Reveal` patterns, `motion`, and `cn`.

## Content (six tabs)

Section header: eyebrow **`USE CASES`**, heading **"An agent for every job on your
plate"**, subhead *"One workforce, every department. Watch an agent take a real task
end to end — then open the full playbook."*

### ① Triage Customer Signals · Support → `customer-support-ticket-triage`
- **Tab desc:** Route and prioritize inbound signals automatically
- **Headline:** Turn customer noise into prioritized action
- **Body:** Agents pull signals from tickets, Slack, and your CRM — then classify,
  deduplicate, and route each to the right team with full context. Every step runs in
  an isolated sandbox, and nothing reaches a customer without review.
- **Log:**
  - `› Ingesting 340 signals from 4 sources.`
  - `› Classified: 12 critical, 45 high, 283 routine`
  - `› Deduplicated 67 signals → 28 unique issues`
  - `› Routed to 3 teams with context attached`
  - `› 12 critical issues escalated · avg response 4min`

### ② Ship Backlog Tickets · Engineering → `software-and-saas-bug-triage`
- **Tab desc:** Pick up backlog tickets and open reviewed change requests
- **Headline:** From backlog ticket to reviewed change request
- **Body:** Point a coding agent at your backlog. It reads the issue, works in its own
  sandbox on its own branch, and opens a change request with a preview — so every line
  lands on `main` through review, never a black box.
- **Log:**
  - `› Picked up 8 tickets from the backlog`
  - `› Spun up 8 isolated sandboxes in parallel`
  - `› Wrote code + tests · 6 ready, 2 need input`
  - `› Opened 6 change requests with previews`
  - `› Awaiting human review before merge to main`

### ③ Fill the Pipeline · Sales → `sales-and-revenue-lead-research`
- **Tab desc:** Research accounts and draft outreach at scale
- **Headline:** Research every account, draft every touch
- **Body:** Agents enrich and rank your accounts, draft personalized outreach, and keep
  the CRM clean — so your team walks into every call prepped, not scrambling.
- **Log:**
  - `› Enriched 1,200 accounts from 5 sources`
  - `› Ranked and scored by fit and intent`
  - `› Drafted 340 personalized outreach sequences`
  - `› Updated 1,200 CRM records · 0 duplicates`
  - `› 18 call briefs ready for tomorrow`

### ④ Close the Books · Finance → `finance-and-accounting-reconciliation`
- **Tab desc:** Reconcile, report, and close with an audit trail
- **Headline:** Reconcile and close, with a trail you can audit
- **Body:** Agents capture invoices, tie out accounts, and flag policy exceptions —
  leaving a reviewable run log behind every number, so the close is fast and fully
  auditable.
- **Log:**
  - `› Captured 482 invoices · matched 461`
  - `› Reconciled 14 accounts · 21 exceptions flagged`
  - `› Drafted board report from consolidated data`
  - `› Every figure linked to its source document`
  - `› Ready for controller sign-off`

### ⑤ Brief to Campaign · Marketing → `marketing-and-creative-content-engine`
- **Tab desc:** Turn a brief into on-brand, ready-to-ship work
- **Headline:** Turn a brief into a campaign that's ready to ship
- **Body:** Hand agents a brief and your brand. They research, draft, and interlink
  pages, posts, and ad variations on brand — and hand back finished work for a human to
  approve before anything goes live.
- **Log:**
  - `› Read brief + brand guidelines`
  - `› Researched 24 keywords and 6 competitors`
  - `› Drafted 12 posts, 4 pages, 30 ad variations`
  - `› Checked every asset against brand voice`
  - `› Queued for review · publish on approval`

### ⑥ Run the Back Office · Ops → `operations-and-supply-chain-sop-automation`
- **Tab desc:** Turn playbooks into workflows that run themselves
- **Headline:** Turn playbooks into workflows that run themselves
- **Body:** Agents track orders across suppliers, watch vendor performance, and turn
  your SOPs into workflows triggered on a schedule or a webhook — so the business keeps
  running while your team sleeps.
- **Log:**
  - `› Tracked 96 orders across 11 suppliers`
  - `› Flagged 4 delayed shipments · opened actions`
  - `› Ran 7 SOPs on schedule overnight`
  - `› Logged every action to an audit trail`
  - `› 2 exceptions routed for human decision`

### Suggested tab icons (lucide-react)

| Tab | Icon |
| --- | --- |
| Triage Customer Signals | `Activity` |
| Ship Backlog Tickets | `GitBranch` |
| Fill the Pipeline | `TrendingUp` |
| Close the Books | `FileText` |
| Brief to Campaign | `Sparkles` |
| Run the Back Office | `Box` |

## Layout, motion & responsive

- **Desktop (`lg+`):** one bordered card (`border-border bg-card rounded-sm border`)
  with a two-column grid `lg:grid-cols-[0.9fr_1.4fr]`. Left = vertical rail of tab
  buttons; active tab gets a left accent bar + `bg-foreground text-background`. Right =
  content panel (eyebrow → headline → paragraph → run-log box → `Learn more →`).
- **Run-log box:** `border-border/60` inset block, mono text, each line muted, `›`
  prefix preserved from content. On the active tab, the label/first token may use the
  `KORTIX_BULLET_GRADIENT` animated treatment for a subtle "alive" feel (optional,
  matches Work Loop labels).
- **Mobile (`< lg`):** rail collapses to a horizontal, scrollable tab strip above the
  panel (reuse the Work Loop mobile pattern).
- **Motion:** `Reveal` on the section; the active panel cross-fades (small `motion`
  fade/slide) on tab change. First tab active by default. No streaming.
- **A11y:** real `<button>` elements with `aria-selected` + `aria-controls`; the panel
  has `role="tabpanel"` and a matching `id`; arrow-key roving focus across the rail.

## Reuse / consistency checklist

- `Eyebrow` (mono uppercase), `Reveal`, `max-w-6xl px-6 py-16 sm:py-24` section frame.
- Marketing `Button` (`@/components/ui/marketing/button`) + `HiArrowRight` for the link.
- `cn` for conditional classes; `motion/react` for transitions.
- No new design primitives — match the existing Work Loop / split-path card styling.

## Out of scope

- i18n: section ships with hardcoded English copy initially (the `/use-cases` page
  itself already mixes hardcoded + i18n; matching that is a fast follow, not this work).
- No streaming/typewriter animation for the log.
- No changes to the `/use-cases` index or `[slug]` pages beyond relying on existing slugs.
