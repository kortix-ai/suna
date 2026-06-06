# Use-Cases Demo Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a vertically-tabbed "An agent for every job on your plate" demo section to the landing page, showcasing six cross-functional flagship agent workflows with a static terminal run-log and per-tab deep-links into `/use-cases`.

**Architecture:** A new landing-specific data module (`landing-demos.ts`) holds the six workflow entries (icon, copy, run-log lines, learn-more slug). A new self-contained client component (`use-case-showcase.tsx`) renders a left tab-rail + right content panel, and is dropped into `page.tsx` after the existing "Work Loop" section. Reuses the page's existing design language (`Reveal`, mono eyebrow, `border-border bg-card rounded-sm`, marketing `Button`, `cn`, `motion`).

**Tech Stack:** Next.js (App Router), React 19, TypeScript, Tailwind CSS v4, `motion/react`, `lucide-react`, `react-icons/hi2`.

**Verification note:** This repo has no unit-test harness for landing/marketing components (only a node test for file-search and Playwright e2e). Per-task verification gates are therefore: TypeScript compile (`pnpm exec tsc --noEmit`), lint (`pnpm lint`), and a manual dev-server visual check. All commands run from `apps/web` unless stated.

---

### Task 1: Landing-demo data module

**Files:**
- Create: `apps/web/src/features/use-cases/landing-demos.ts`

- [ ] **Step 1: Create the data module with all six entries**

Create `apps/web/src/features/use-cases/landing-demos.ts`:

```ts
import type { LucideIcon } from 'lucide-react';
import { Activity, Box, FileText, GitBranch, Sparkles, TrendingUp } from 'lucide-react';

export type LandingDemo = {
  id: string;
  icon: LucideIcon;
  tabTitle: string;
  tabDescription: string;
  eyebrow: string;
  title: string;
  description: string;
  log: string[];
  learnMoreSlug: string;
};

export const LANDING_DEMOS: LandingDemo[] = [
  {
    id: 'triage-customer-signals',
    icon: Activity,
    tabTitle: 'Triage Customer Signals',
    tabDescription: 'Route and prioritize inbound signals automatically',
    eyebrow: 'Triage customer signals',
    title: 'Turn customer noise into prioritized action',
    description:
      'Agents pull signals from tickets, Slack, and your CRM — then classify, deduplicate, and route each to the right team with full context. Every step runs in an isolated sandbox, and nothing reaches a customer without review.',
    log: [
      '› Ingesting 340 signals from 4 sources.',
      '› Classified: 12 critical, 45 high, 283 routine',
      '› Deduplicated 67 signals → 28 unique issues',
      '› Routed to 3 teams with context attached',
      '› 12 critical issues escalated · avg response 4min',
    ],
    learnMoreSlug: 'customer-support-ticket-triage',
  },
  {
    id: 'ship-backlog-tickets',
    icon: GitBranch,
    tabTitle: 'Ship Backlog Tickets',
    tabDescription: 'Pick up backlog tickets and open reviewed change requests',
    eyebrow: 'Ship backlog tickets',
    title: 'From backlog ticket to reviewed change request',
    description:
      'Point a coding agent at your backlog. It reads the issue, works in its own sandbox on its own branch, and opens a change request with a preview — so every line lands on main through review, never a black box.',
    log: [
      '› Picked up 8 tickets from the backlog',
      '› Spun up 8 isolated sandboxes in parallel',
      '› Wrote code + tests · 6 ready, 2 need input',
      '› Opened 6 change requests with previews',
      '› Awaiting human review before merge to main',
    ],
    learnMoreSlug: 'software-and-saas-bug-triage',
  },
  {
    id: 'fill-the-pipeline',
    icon: TrendingUp,
    tabTitle: 'Fill the Pipeline',
    tabDescription: 'Research accounts and draft outreach at scale',
    eyebrow: 'Fill the pipeline',
    title: 'Research every account, draft every touch',
    description:
      'Agents enrich and rank your accounts, draft personalized outreach, and keep the CRM clean — so your team walks into every call prepped, not scrambling.',
    log: [
      '› Enriched 1,200 accounts from 5 sources',
      '› Ranked and scored by fit and intent',
      '› Drafted 340 personalized outreach sequences',
      '› Updated 1,200 CRM records · 0 duplicates',
      '› 18 call briefs ready for tomorrow',
    ],
    learnMoreSlug: 'sales-and-revenue-lead-research',
  },
  {
    id: 'close-the-books',
    icon: FileText,
    tabTitle: 'Close the Books',
    tabDescription: 'Reconcile, report, and close with an audit trail',
    eyebrow: 'Close the books',
    title: 'Reconcile and close, with a trail you can audit',
    description:
      'Agents capture invoices, tie out accounts, and flag policy exceptions — leaving a reviewable run log behind every number, so the close is fast and fully auditable.',
    log: [
      '› Captured 482 invoices · matched 461',
      '› Reconciled 14 accounts · 21 exceptions flagged',
      '› Drafted board report from consolidated data',
      '› Every figure linked to its source document',
      '› Ready for controller sign-off',
    ],
    learnMoreSlug: 'finance-and-accounting-reconciliation',
  },
  {
    id: 'brief-to-campaign',
    icon: Sparkles,
    tabTitle: 'Brief to Campaign',
    tabDescription: 'Turn a brief into on-brand, ready-to-ship work',
    eyebrow: 'Brief to campaign',
    title: "Turn a brief into a campaign that's ready to ship",
    description:
      'Hand agents a brief and your brand. They research, draft, and interlink pages, posts, and ad variations on brand — and hand back finished work for a human to approve before anything goes live.',
    log: [
      '› Read brief + brand guidelines',
      '› Researched 24 keywords and 6 competitors',
      '› Drafted 12 posts, 4 pages, 30 ad variations',
      '› Checked every asset against brand voice',
      '› Queued for review · publish on approval',
    ],
    learnMoreSlug: 'marketing-and-creative-content-engine',
  },
  {
    id: 'run-the-back-office',
    icon: Box,
    tabTitle: 'Run the Back Office',
    tabDescription: 'Turn playbooks into workflows that run themselves',
    eyebrow: 'Run the back office',
    title: 'Turn playbooks into workflows that run themselves',
    description:
      'Agents track orders across suppliers, watch vendor performance, and turn your SOPs into workflows triggered on a schedule or a webhook — so the business keeps running while your team sleeps.',
    log: [
      '› Tracked 96 orders across 11 suppliers',
      '› Flagged 4 delayed shipments · opened actions',
      '› Ran 7 SOPs on schedule overnight',
      '› Logged every action to an audit trail',
      '› 2 exceptions routed for human decision',
    ],
    learnMoreSlug: 'operations-and-supply-chain-sop-automation',
  },
];
```

- [ ] **Step 2: Verify the slugs resolve to real use-case pages**

Run (from `apps/web`):

```bash
node --experimental-strip-types -e "
import { LANDING_DEMOS } from './src/features/use-cases/landing-demos.ts';
import { getUseCaseBySlug } from './src/features/use-cases/data.ts';
for (const d of LANDING_DEMOS) {
  const ok = !!getUseCaseBySlug(d.learnMoreSlug);
  console.log((ok ? 'OK  ' : 'FAIL') + ' ' + d.learnMoreSlug);
  if (!ok) process.exitCode = 1;
}
"
```

Expected: six `OK` lines, exit code 0. If any line says `FAIL`, the slug does not match `slugFor(industry, agent.name)` in `data.ts` — fix the `learnMoreSlug` to a valid slug before continuing.

- [ ] **Step 3: Typecheck**

Run (from `apps/web`): `pnpm exec tsc --noEmit`
Expected: completes with no errors referencing `landing-demos.ts`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/features/use-cases/landing-demos.ts
git commit -m "feat(web): add landing-demo data for use-cases showcase section"
```

---

### Task 2: UseCaseShowcase component

**Files:**
- Create: `apps/web/src/components/home/use-case-showcase.tsx`

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/home/use-case-showcase.tsx`:

```tsx
'use client';

import { Reveal } from '@/components/home/reveal';
import { Button } from '@/components/ui/marketing/button';
import { LANDING_DEMOS, type LandingDemo } from '@/features/use-cases/landing-demos';
import { cn } from '@/lib/utils';
import { AnimatePresence, motion } from 'motion/react';
import Link from 'next/link';
import { useState } from 'react';
import { HiArrowRight } from 'react-icons/hi2';

function DemoPanel({ demo }: { demo: LandingDemo }) {
  return (
    <div
      role="tabpanel"
      id={`use-case-panel-${demo.id}`}
      aria-labelledby={`use-case-tab-${demo.id}`}
      className="flex flex-col p-6 sm:p-8"
    >
      <span className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
        {demo.eyebrow}
      </span>
      <h3 className="text-foreground mt-4 text-2xl leading-tight font-medium tracking-tight sm:text-3xl">
        {demo.title}
      </h3>
      <p className="text-muted-foreground mt-4 text-base leading-relaxed">{demo.description}</p>
      <div className="border-border/60 bg-background/40 mt-6 rounded-sm border p-4">
        <ul className="space-y-2 font-mono text-xs sm:text-sm">
          {demo.log.map((line, i) => (
            <li key={i} className="text-muted-foreground leading-relaxed">
              {line}
            </li>
          ))}
        </ul>
      </div>
      <Button asChild variant="ghost" size="sm" className="text-primary mt-6 self-start px-0">
        <Link href={`/use-cases/${demo.learnMoreSlug}`}>
          Learn more
          <HiArrowRight className="size-4" />
        </Link>
      </Button>
    </div>
  );
}

export function UseCaseShowcase() {
  const [activeId, setActiveId] = useState(LANDING_DEMOS[0].id);
  const active = LANDING_DEMOS.find((d) => d.id === activeId) ?? LANDING_DEMOS[0];

  return (
    <section className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24">
      <Reveal>
        <div className="mb-2 max-w-2xl">
          <span className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
            Use cases
          </span>
          <h2 className="text-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
            An agent for every job on your plate
          </h2>
          <p className="text-muted-foreground mt-4 text-base leading-relaxed">
            One workforce, every department. Watch an agent take a real task end to end — then open
            the full playbook.
          </p>
        </div>
      </Reveal>

      <Reveal delay={0.1}>
        <div className="border-border bg-card overflow-hidden rounded-sm border">
          {/* Mobile: horizontal scrollable tab strip */}
          <div
            role="tablist"
            aria-orientation="horizontal"
            className="scrollbar-hide border-border/60 flex gap-2 overflow-x-auto border-b p-3 lg:hidden"
          >
            {LANDING_DEMOS.map((demo) => {
              const isActive = demo.id === active.id;
              const Icon = demo.icon;
              return (
                <button
                  key={demo.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`use-case-panel-${demo.id}`}
                  id={`use-case-tab-${demo.id}`}
                  onClick={() => setActiveId(demo.id)}
                  className={cn(
                    'flex shrink-0 items-center gap-2 rounded px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-foreground text-background'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Icon className="size-4" />
                  {demo.tabTitle}
                </button>
              );
            })}
          </div>

          <div className="grid gap-0 lg:grid-cols-[0.9fr_1.4fr]">
            {/* Desktop: vertical rail */}
            <div
              role="tablist"
              aria-orientation="vertical"
              className="border-border/60 hidden flex-col border-r lg:flex"
            >
              {LANDING_DEMOS.map((demo) => {
                const isActive = demo.id === active.id;
                const Icon = demo.icon;
                return (
                  <button
                    key={demo.id}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    aria-controls={`use-case-panel-${demo.id}`}
                    id={`use-case-tab-${demo.id}`}
                    onClick={() => setActiveId(demo.id)}
                    className={cn(
                      'group border-border/60 flex flex-col gap-1 border-b border-l-2 p-5 text-left transition-colors last:border-b-0',
                      isActive
                        ? 'border-l-primary bg-muted/50'
                        : 'border-l-transparent hover:bg-muted/30',
                    )}
                  >
                    <span className="flex items-center gap-2.5">
                      <Icon
                        className={cn(
                          'size-4 shrink-0 transition-colors',
                          isActive ? 'text-primary' : 'text-muted-foreground',
                        )}
                      />
                      <span
                        className={cn(
                          'font-mono text-xs tracking-wider uppercase transition-colors',
                          isActive ? 'text-foreground' : 'text-muted-foreground',
                        )}
                      >
                        {demo.tabTitle}
                      </span>
                    </span>
                    <span className="text-muted-foreground pl-[1.625rem] text-sm leading-snug">
                      {demo.tabDescription}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Content panel */}
            <div className="relative min-h-[22rem]">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={active.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.25, ease: 'easeOut' }}
                >
                  <DemoPanel demo={active} />
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
```

- [ ] **Step 2: Typecheck**

Run (from `apps/web`): `pnpm exec tsc --noEmit`
Expected: no errors referencing `use-case-showcase.tsx`. Common failure: a wrong import path for `Button` or `Reveal` — confirm `@/components/ui/marketing/button` and `@/components/home/reveal` both resolve (they are used in `apps/web/src/app/(home)/page.tsx`).

- [ ] **Step 3: Lint**

Run (from `apps/web`): `pnpm lint`
Expected: no new errors for `use-case-showcase.tsx`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/home/use-case-showcase.tsx
git commit -m "feat(web): add UseCaseShowcase tabbed demo component"
```

---

### Task 3: Wire the section into the landing page

**Files:**
- Modify: `apps/web/src/app/(home)/page.tsx` (add import near the other `@/components/home/*` imports; render `<UseCaseShowcase />` immediately after the "Work Loop" `</section>`, which currently closes around line 613)

- [ ] **Step 1: Add the import**

In `apps/web/src/app/(home)/page.tsx`, add this import alongside the existing home-component imports (e.g. directly under the `import { InteractiveDemo } from '@/components/home/interactive-demo';` line):

```tsx
import { UseCaseShowcase } from '@/components/home/use-case-showcase';
```

- [ ] **Step 2: Render the section after the Work Loop section**

Find the end of the "Work Loop" section — the `</section>` that closes the block beginning with `<section className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24">` and containing `tHome('workLoopEyebrow')` (closes near line 613). Immediately AFTER that closing `</section>` and BEFORE the `<section id="different-screen-section" ...>` line, insert:

```tsx
        <UseCaseShowcase />

```

The result should read:

```tsx
            </div>
          </Reveal>
        </section>

        <UseCaseShowcase />

        <section id="different-screen-section" className="py-16 sm:py-24">
```

- [ ] **Step 3: Typecheck**

Run (from `apps/web`): `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Lint**

Run (from `apps/web`): `pnpm lint`
Expected: no new errors in `page.tsx`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/(home)/page.tsx
git commit -m "feat(web): render use-cases showcase section on landing page"
```

---

### Task 4: Visual verification & final check

**Files:** none (verification only)

- [ ] **Step 1: Start the dev server**

Run (from `apps/web`): `pnpm dev`
Expected: server boots on `http://localhost:3000` (or `WEB_PORT`).

- [ ] **Step 2: Visually verify the section on `/`**

Open `http://localhost:3000/` and scroll to the new section (right after "Work Loop"). Confirm:
- Heading reads "An agent for every job on your plate" with the "Use cases" eyebrow.
- Desktop (≥1024px): six tabs in a vertical left rail with icon + title + description; the active tab has a left accent bar and tinted background; clicking a tab swaps the right panel with a short fade.
- The right panel shows eyebrow → headline → paragraph → a bordered mono run-log box → "Learn more →".
- Mobile (<1024px, narrow the window): the rail becomes a horizontal scrollable tab strip above the panel.

- [ ] **Step 3: Verify each "Learn more" deep-link**

Click "Learn more →" on at least two tabs (e.g. Triage Customer Signals and Close the Books). Expected: navigates to `/use-cases/customer-support-ticket-triage` and `/use-cases/finance-and-accounting-reconciliation` respectively, each rendering a real use-case detail page (not a 404).

- [ ] **Step 4: Production build sanity check**

Stop the dev server. Run (from `apps/web`): `pnpm build`
Expected: build completes successfully with the home route included and no errors from the new files.

- [ ] **Step 5: Final commit (only if Step 4 surfaced fixes)**

```bash
git add -A
git commit -m "fix(web): address build/lint issues in use-cases showcase"
```

---

## Self-Review

- **Spec coverage:** Data module (Task 1) ✓ · component with rail + panel + run-log + learn-more (Task 2) ✓ · placement after Work Loop (Task 3) ✓ · cross-functional 6-tab content (Task 1 data) ✓ · static log, deep-links, responsive rail→strip, motion cross-fade, a11y roles (Task 2) ✓ · slug-resolves-to-real-page guarantee (Task 1 Step 2 + Task 4 Step 3) ✓.
- **Out-of-scope items** (i18n, streaming) intentionally excluded, matching the spec.
- **Type consistency:** `LandingDemo` fields used in the component (`icon`, `tabTitle`, `tabDescription`, `eyebrow`, `title`, `description`, `log`, `learnMoreSlug`, `id`) exactly match the type defined in Task 1. The exported symbol `UseCaseShowcase` (Task 2) matches the import/usage in Task 3.
- **No placeholders:** every code step contains complete, runnable content.
