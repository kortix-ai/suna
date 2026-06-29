'use client';

import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  AtSign,
  Boxes,
  FileCode2,
  FileText,
  Folder,
  FolderTree,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Layers,
  Users,
  Workflow,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

const sectionShell = 'mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0';

/* ================================================================== */
/* Problem — 1% vs 99% (the video's cold open), big and stark          */
/* ================================================================== */

export function ProblemSection() {
  const tHome = useTranslations('hardcodedUi.appHomePage');

  return (
    <section className={sectionShell}>
      <Reveal>
        <div className="max-w-3xl space-y-4">
          <Badge variant="kortix" className="rounded">
            {tHome('problemEyebrow')}
          </Badge>
          <h2 className="text-foreground text-3xl font-medium tracking-tight text-balance sm:text-4xl">
            {tHome('problemTitle')}
          </h2>
        </div>

        <div className="bg-border mt-12 grid gap-px overflow-hidden rounded-sm border md:grid-cols-2">
          <div className="bg-card p-8 md:p-10">
            <div className="text-foreground font-mono text-6xl font-medium tracking-tight sm:text-7xl">
              {tHome('problemOnePercentLabel')}
            </div>
            <h3 className="text-foreground mt-6 text-xl font-medium tracking-tight">
              {tHome('problemOnePercentTitle')}
            </h3>
            <p className="text-muted-foreground mt-3 max-w-md text-base leading-relaxed">
              {tHome('problemOnePercentBody')}
            </p>
          </div>
          <div className="bg-card p-8 md:p-10">
            <div className="text-muted-foreground/40 font-mono text-6xl font-medium tracking-tight sm:text-7xl">
              {tHome('problemRestLabel')}
            </div>
            <h3 className="text-foreground mt-6 text-xl font-medium tracking-tight">
              {tHome('problemRestTitle')}
            </h3>
            <p className="text-muted-foreground mt-3 max-w-md text-base leading-relaxed">
              {tHome('problemRestBody')}
            </p>
          </div>
        </div>

        <p className="text-foreground mt-12 max-w-4xl text-2xl font-medium tracking-tight text-balance sm:text-3xl">
          {tHome('problemTurn')}
        </p>
      </Reveal>
    </section>
  );
}

/* ================================================================== */
/* Company as files — interactive repo explorer (the centerpiece)      */
/* ================================================================== */

type RepoFile = { lang: 'toml' | 'md'; lines: string[] };

const FILES: Record<string, RepoFile> = {
  'kortix.toml': {
    lang: 'toml',
    lines: [
      '[project]',
      'name = "acme"',
      '',
      '[[connectors]]      # 3,000+ apps, one scoped token',
      'slug = "slack"',
      '',
      '[[agents]]',
      'name = "go-to-market"',
      'connectors = ["slack", "hubspot", "gmail"]',
      '',
      '[[triggers]]        # runs in a loop, in the night',
      'slug = "morning-brief"',
      'cron = "0 8 * * 1-5"',
      '',
      '[[channels]]        # delivered where people work',
      'slug = "slack"',
    ],
  },
  'sales/renewals/SKILL.md': {
    lang: 'md',
    lines: [
      '# Renewal play',
      '',
      'How we walk a customer through a renewal —',
      'the right way, every time.',
      '',
      '## Steps',
      '- Pull usage + health from the last 90 days',
      "- Draft the renewal summary in the account's voice",
      '- Flag risk; route discounts > 15% for approval',
      '- Send, then log the outcome to the audit trail',
    ],
  },
  'agents/go-to-market.md': {
    lang: 'md',
    lines: [
      '# go-to-market',
      '',
      'The one agent your team asks. It routes the ask to',
      'the right skill — no one remembers which agent does what.',
      '',
      '## Reach',
      '- connectors: slack, hubspot, gmail, linkedin',
      '- skills: prospecting, rfp-response, renewals',
      '',
      '## Says',
      '"Draft the renewal for Acme" -> renewals/SKILL.md',
    ],
  },
  'finance/close-the-month/SKILL.md': {
    lang: 'md',
    lines: [
      '# Close the month',
      '',
      'Reconcile the books, flag the exceptions, hold for sign-off.',
      '',
      '## Steps',
      '- Match transactions across Stripe + the ledger',
      "- Flag anything that doesn't reconcile",
      '- Draft the P&L summary',
      '- Pause at the approval gate before anything posts',
    ],
  },
  'AGENTS.md': {
    lang: 'md',
    lines: [
      '# How this company works',
      '',
      'Everything is a file in this repo. Every team shares it.',
      '',
      '- Skills live under each function as SKILL.md',
      '- Agents are markdown personas in /agents',
      '- What we learn lands in /memory',
      '- Work reaches main only through a change request',
    ],
  },
  'sales/prospecting/SKILL.md': {
    lang: 'md',
    lines: [
      '# Prospecting',
      '',
      'Find and qualify accounts that look like our best customers.',
      '',
      '## Steps',
      '- Pull the ICP from memory/customers.md',
      '- Enrich from the CRM + LinkedIn',
      '- Score and hand the top 20 to the rep',
    ],
  },
  'sales/rfp-response/SKILL.md': {
    lang: 'md',
    lines: [
      '# RFP response',
      '',
      'Turn an RFP into a first-draft response in our voice.',
      '',
      '## Steps',
      '- Map each requirement to a proof point',
      '- Draft answers, cite docs and past wins',
      '- Flag anything legal needs to review',
    ],
  },
  'success/onboarding/SKILL.md': {
    lang: 'md',
    lines: [
      '# Onboarding',
      '',
      'Get a new customer to first value in week one.',
      '',
      '## Steps',
      '- Stand up their workspace from the template',
      '- Book kickoff, share the rollout plan',
      '- Check activation daily, nudge where stuck',
    ],
  },
  'success/qbr-prep/SKILL.md': {
    lang: 'md',
    lines: [
      '# QBR prep',
      '',
      'Build the quarterly business review before the call.',
      '',
      '## Steps',
      '- Pull usage, value delivered, open risks',
      '- Draft the deck from the QBR template',
      '- Surface upsell signals for the AM',
    ],
  },
  'finance/invoicing/SKILL.md': {
    lang: 'md',
    lines: [
      '# Invoicing',
      '',
      'Raise, send, and reconcile invoices on schedule.',
      '',
      '## Steps',
      '- Generate invoices from the billing system',
      '- Match payments in Stripe',
      '- Chase overdue, escalate past 30 days',
    ],
  },
  'marketing/launch/SKILL.md': {
    lang: 'md',
    lines: [
      '# Launch',
      '',
      'Ship a launch the same way every time.',
      '',
      '## Steps',
      '- Draft the thread, blog, and changelog',
      '- Check brand rules, route for review',
      '- Schedule, then track reach + installs',
    ],
  },
  'marketing/seo/SKILL.md': {
    lang: 'md',
    lines: [
      '# SEO',
      '',
      'Plan, write, and rank a piece of content.',
      '',
      '## Steps',
      '- Pick the keyword from the gap report',
      '- Draft, fact-check, add internal links',
      '- Publish and watch the ranking',
    ],
  },
  'engineering/pr-review/SKILL.md': {
    lang: 'md',
    lines: [
      '# PR review',
      '',
      'A senior review on every pull request.',
      '',
      '## Steps',
      '- Stand up a preview, run the tests',
      '- Review for bugs, design, standards',
      '- Auto-fix the mechanical, comment the rest',
    ],
  },
  'engineering/incident/SKILL.md': {
    lang: 'md',
    lines: [
      '# Incident response',
      '',
      'Drive a production incident to resolved.',
      '',
      '## Steps',
      '- Open one thread, post every update there',
      '- Pull the logs, find the regression',
      '- Ship the fix, write the postmortem',
    ],
  },
  'support/triage/SKILL.md': {
    lang: 'md',
    lines: [
      '# Support triage',
      '',
      'Read, categorize, and answer inbound tickets.',
      '',
      '## Steps',
      '- Pull the ticket + customer history',
      '- Draft a reply from the docs',
      '- Escalate only what needs a human',
    ],
  },
  'agents/analyst.md': {
    lang: 'md',
    lines: [
      '# analyst',
      '',
      'Turns a plain question into SQL and a dashboard.',
      '',
      '## Reach',
      '- connectors: warehouse, metabase',
      '- skills: profiling, sql, charts',
    ],
  },
  'agents/support-triage.md': {
    lang: 'md',
    lines: [
      '# support-triage',
      '',
      'Categorizes and routes every inbound ticket.',
      '',
      '## Reach',
      '- connectors: zendesk, slack',
      '- skills: support/triage',
    ],
  },
  'memory/company.md': {
    lang: 'md',
    lines: [
      '# Company memory',
      '',
      'What everyone should know — and it compounds every run.',
      '',
      '- Who we are, how we talk, what we value',
      '- The metrics we watch and our targets',
      '- Shared by every agent, in every session',
    ],
  },
  'memory/customers.md': {
    lang: 'md',
    lines: [
      '# Customers',
      '',
      'The accounts, their context, what they love.',
      '',
      '- ICP and segments',
      '- Per-account notes pulled from calls',
      '- Renewal dates and health',
    ],
  },
  'memory/decisions.md': {
    lang: 'md',
    lines: [
      '# Decisions',
      '',
      'Why we did what we did — so we never relitigate.',
      '',
      '- Each entry: context, decision, date',
      '- Linked from the change request that made it',
    ],
  },
};

type TreeNode = {
  label: string;
  depth: number;
  kind: 'folder' | 'file';
  fileId?: keyof typeof FILES;
  dim?: boolean;
};

const TREE: TreeNode[] = [
  { label: 'kortix.toml', depth: 0, kind: 'file', fileId: 'kortix.toml' },
  { label: 'AGENTS.md', depth: 0, kind: 'file', fileId: 'AGENTS.md' },
  { label: 'sales', depth: 0, kind: 'folder' },
  { label: 'prospecting/SKILL.md', depth: 1, kind: 'file', fileId: 'sales/prospecting/SKILL.md' },
  { label: 'rfp-response/SKILL.md', depth: 1, kind: 'file', fileId: 'sales/rfp-response/SKILL.md' },
  { label: 'renewals/SKILL.md', depth: 1, kind: 'file', fileId: 'sales/renewals/SKILL.md' },
  { label: 'success', depth: 0, kind: 'folder' },
  { label: 'onboarding/SKILL.md', depth: 1, kind: 'file', fileId: 'success/onboarding/SKILL.md' },
  { label: 'qbr-prep/SKILL.md', depth: 1, kind: 'file', fileId: 'success/qbr-prep/SKILL.md' },
  { label: 'finance', depth: 0, kind: 'folder' },
  {
    label: 'close-the-month/SKILL.md',
    depth: 1,
    kind: 'file',
    fileId: 'finance/close-the-month/SKILL.md',
  },
  { label: 'invoicing/SKILL.md', depth: 1, kind: 'file', fileId: 'finance/invoicing/SKILL.md' },
  { label: 'marketing', depth: 0, kind: 'folder' },
  { label: 'launch/SKILL.md', depth: 1, kind: 'file', fileId: 'marketing/launch/SKILL.md' },
  { label: 'seo/SKILL.md', depth: 1, kind: 'file', fileId: 'marketing/seo/SKILL.md' },
  { label: 'engineering', depth: 0, kind: 'folder' },
  { label: 'pr-review/SKILL.md', depth: 1, kind: 'file', fileId: 'engineering/pr-review/SKILL.md' },
  { label: 'incident/SKILL.md', depth: 1, kind: 'file', fileId: 'engineering/incident/SKILL.md' },
  { label: 'support', depth: 0, kind: 'folder' },
  { label: 'triage/SKILL.md', depth: 1, kind: 'file', fileId: 'support/triage/SKILL.md' },
  { label: 'agents', depth: 0, kind: 'folder' },
  { label: 'go-to-market.md', depth: 1, kind: 'file', fileId: 'agents/go-to-market.md' },
  { label: 'analyst.md', depth: 1, kind: 'file', fileId: 'agents/analyst.md' },
  { label: 'support-triage.md', depth: 1, kind: 'file', fileId: 'agents/support-triage.md' },
  { label: 'memory', depth: 0, kind: 'folder' },
  { label: 'company.md', depth: 1, kind: 'file', fileId: 'memory/company.md' },
  { label: 'customers.md', depth: 1, kind: 'file', fileId: 'memory/customers.md' },
  { label: 'decisions.md', depth: 1, kind: 'file', fileId: 'memory/decisions.md' },
];

function TomlLine({ line }: { line: string }) {
  const hashIndex = line.indexOf('#');
  if (hashIndex === -1) {
    return <div className="text-foreground/85 whitespace-pre">{line || ' '}</div>;
  }
  return (
    <div className="whitespace-pre">
      <span className="text-foreground/85">{line.slice(0, hashIndex)}</span>
      <span className="text-muted-foreground/55">{line.slice(hashIndex)}</span>
    </div>
  );
}

function MdLine({ line }: { line: string }) {
  if (line.startsWith('#')) {
    return <div className="text-foreground font-semibold whitespace-pre">{line}</div>;
  }
  if (line.startsWith('-')) {
    return <div className="text-muted-foreground whitespace-pre">{line}</div>;
  }
  return <div className="text-muted-foreground/80 whitespace-pre">{line || ' '}</div>;
}

function CodeBody({ file }: { file: RepoFile }) {
  // Each file's lines are static and never reordered, so a content+position key is stable.
  return (
    <>
      {file.lines.map((line, i) =>
        file.lang === 'toml' ? (
          <TomlLine key={`${i}:${line}`} line={line} />
        ) : (
          <MdLine key={`${i}:${line}`} line={line} />
        ),
      )}
    </>
  );
}

function RepoExplorer() {
  const tHome = useTranslations('hardcodedUi.appHomePage');
  const [activeId, setActiveId] = useState<keyof typeof FILES>('kortix.toml');
  const active = FILES[activeId];

  return (
    <div className="border-border bg-card overflow-hidden rounded-sm border">
      {/* window chrome */}
      <div className="border-border flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <FolderTree className="text-muted-foreground size-4" />
          <span className="text-muted-foreground font-mono text-xs">
            {tHome('codeWindowTitle')}
          </span>
        </div>
        <div className="text-muted-foreground flex items-center gap-1.5 font-mono text-xs">
          <GitBranch className="size-3.5" />
          {tHome('codeBranchLabel')}
        </div>
      </div>

      <div className="grid md:grid-cols-[minmax(0,15rem)_1fr]">
        {/* file tree */}
        <div className="border-border bg-background/40 max-h-[300px] overflow-y-auto border-b py-2 md:max-h-[540px] md:border-r md:border-b-0">
          {TREE.map((node) => {
            const isActive = node.fileId === activeId;
            const isClickable = Boolean(node.fileId);
            const Icon = node.kind === 'folder' ? Folder : FileText;
            return (
              <button
                key={`${node.depth}-${node.label}`}
                type="button"
                disabled={!isClickable}
                onClick={() => node.fileId && setActiveId(node.fileId)}
                style={{ paddingLeft: `${0.75 + node.depth * 1}rem` }}
                className={cn(
                  'flex w-full items-center gap-2 py-1.5 pr-3 text-left font-mono text-xs transition-colors duration-fast',
                  isActive && 'bg-primary/[0.07] text-primary',
                  !isActive && isClickable && 'text-foreground/80 hover:bg-foreground/[0.04]',
                  !isClickable && 'text-muted-foreground/50 cursor-default',
                )}
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="truncate">{node.label}</span>
              </button>
            );
          })}
        </div>

        {/* file viewer */}
        <div className="flex min-w-0 flex-col">
          <div className="border-border text-muted-foreground flex items-center gap-2 border-b px-4 py-2.5 font-mono text-xs">
            {active.lang === 'toml' ? (
              <FileCode2 className="size-3.5" />
            ) : (
              <FileText className="size-3.5" />
            )}
            <span className="truncate">{activeId}</span>
          </div>
          <div className="max-h-[540px] min-h-[420px] flex-1 overflow-auto p-5 font-mono text-xs leading-relaxed">
            <CodeBody file={active} />
          </div>
        </div>
      </div>
    </div>
  );
}

const codePoints = [
  { title: 'codePoint1Title', body: 'codePoint1Body', icon: FileCode2 },
  { title: 'codePoint2Title', body: 'codePoint2Body', icon: Workflow },
  { title: 'codePoint3Title', body: 'codePoint3Body', icon: Layers },
  { title: 'codePoint4Title', body: 'codePoint4Body', icon: GitBranch },
];

export function CompanyAsCodeSection() {
  const tHome = useTranslations('hardcodedUi.appHomePage');

  return (
    <section className={sectionShell}>
      <Reveal>
        <div className="mb-12 max-w-2xl space-y-3">
          <Badge variant="kortix" className="rounded">
            {tHome('codeEyebrow')}
          </Badge>
          <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
            {tHome('codeTitle')}
          </h2>
          <p className="text-muted-foreground text-base leading-relaxed">
            {tHome('codeDescription')}
          </p>
        </div>

        <RepoExplorer />

        <div className="bg-border mt-4 grid gap-px overflow-hidden rounded-sm border md:grid-cols-2 lg:grid-cols-4">
          {codePoints.map(({ title, body, icon: Icon }) => (
            <div key={title} className="bg-card p-6">
              <Icon className="text-muted-foreground size-5" />
              <h3 className="text-foreground mt-5 text-base font-medium tracking-tight">
                {tHome(title)}
              </h3>
              <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{tHome(body)}</p>
            </div>
          ))}
        </div>
      </Reveal>
    </section>
  );
}

/* ================================================================== */
/* How the company runs — git-flow + loop (replaces the 6-step scroll) */
/* ================================================================== */

function Connector() {
  return <div className="bg-border mx-auto h-8 w-px" aria-hidden />;
}

const sessions = [
  { key: 'runsSession1', icon: Boxes },
  { key: 'runsSession2', icon: Boxes },
  { key: 'runsSession3', icon: Boxes },
];

const runsPoints = [
  { title: 'runsPoint1Title', body: 'runsPoint1Body', icon: Layers },
  { title: 'runsPoint2Title', body: 'runsPoint2Body', icon: Workflow },
  { title: 'runsPoint3Title', body: 'runsPoint3Body', icon: GitPullRequest },
  { title: 'runsPoint4Title', body: 'runsPoint4Body', icon: GitMerge },
];

export function HowItRunsSection() {
  const tHome = useTranslations('hardcodedUi.appHomePage');

  return (
    <section className={sectionShell}>
      <Reveal>
        <div className="mb-12 max-w-2xl space-y-3">
          <Badge variant="kortix" className="rounded">
            {tHome('runsEyebrow')}
          </Badge>
          <h2 className="text-foreground text-3xl font-medium tracking-tight text-balance sm:text-4xl">
            {tHome('runsTitle')}
          </h2>
          <p className="text-muted-foreground text-base leading-relaxed">
            {tHome('runsDescription')}
          </p>
        </div>

        {/* diagram */}
        <div className="border-border bg-card rounded-sm border p-6 md:p-10">
          {/* ask / trigger */}
          <div className="border-border bg-background mx-auto flex w-fit items-center gap-2.5 rounded-sm border px-5 py-3">
            <AtSign className="text-muted-foreground size-4" />
            <span className="text-foreground font-mono text-xs sm:text-sm">{tHome('runsAsk')}</span>
          </div>

          <Connector />

          {/* parallel isolated sessions on branches */}
          <div className="bg-border grid gap-px overflow-hidden rounded-sm border sm:grid-cols-3">
            {sessions.map(({ key, icon: Icon }) => (
              <div key={key} className="bg-background flex flex-col gap-3 p-5">
                <div className="flex items-center gap-2">
                  <Icon className="text-muted-foreground size-4" />
                  <span className="text-foreground font-mono text-xs">{tHome(key)}</span>
                </div>
                <span className="text-muted-foreground/70 font-mono text-[0.7rem]">
                  {tHome('runsSessionMeta')}
                </span>
                <div className="border-border text-muted-foreground mt-1 flex items-center gap-1.5 border-t pt-3 font-mono text-[0.7rem]">
                  <GitPullRequest className="size-3.5" />
                  {tHome('runsChangeRequest')} →
                </div>
              </div>
            ))}
          </div>

          <Connector />

          {/* main, always running, in a loop */}
          <div className="border-border bg-foreground text-background flex items-center justify-between gap-3 rounded-sm border px-5 py-4">
            <div className="flex items-center gap-2.5">
              <GitBranch className="size-4" />
              <span className="font-mono text-xs sm:text-sm">{tHome('runsMain')}</span>
            </div>
            <Users className="text-background/70 size-4" />
          </div>
        </div>

        <div className="bg-border mt-4 grid gap-px overflow-hidden rounded-sm border md:grid-cols-2 lg:grid-cols-4">
          {runsPoints.map(({ title, body, icon: Icon }) => (
            <div key={title} className="bg-card p-6">
              <Icon className="text-muted-foreground size-5" />
              <h3 className="text-foreground mt-5 text-base font-medium tracking-tight">
                {tHome(title)}
              </h3>
              <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{tHome(body)}</p>
            </div>
          ))}
        </div>
      </Reveal>
    </section>
  );
}
