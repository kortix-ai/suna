'use client';

/**
 * The Kortix deck — content & structure mirror the official "Kortix pres ENG"
 * sales narrative as shipped on kortix-deck.vercel.app:
 *   cover → where we come from (Suna) → what is Kortix → connect → configure →
 *   bring your team → talk in Slack → every request runs in Slack → open & yours →
 *   closing (talk to sales).
 * Rendered in the marketing-site visual style (home / developers / enterprise):
 * marketing Badge, mono eyebrows, font-medium tracking-tight titles, rounded-sm
 * thin-border cards, KortixAsterisk bullets, KortixGrid / KortixLetterField
 * motifs, real product screenshots.
 */

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Badge } from '@/components/ui/badge';
import KortixGrid from '@/components/ui/marketing/gridder';
import { KortixLetterField } from '@/components/ui/marketing/kortix-letter-field';
import { cn } from '@/lib/utils';
import {
  Boxes,
  Cpu,
  Eye,
  Lock,
  Mail,
  MessageSquare,
  Plug,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  Users,
  Wallet,
} from 'lucide-react';
import type { ReactNode } from 'react';
import {
  Bullets,
  Dim,
  Eyebrow,
  LabelChip,
  Lead,
  MiniCard,
  Panel,
  Pill,
  SectionHead,
  Shot,
  Slide,
} from './parts';

export type SlideDef = { id: string; label: string; node: ReactNode };

const SHOT = '/images/landing-showcase/platform';

/* ── local bits ─────────────────────────────────────────────────────────── */

function IconFeature({
  icon: Icon,
  step,
  title,
  body,
  className,
}: {
  icon: typeof Plug;
  step?: string;
  title: ReactNode;
  body: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn('border-border bg-card flex flex-col gap-3 rounded-sm border p-6', className)}
    >
      <div className="flex items-center justify-between">
        <Icon className="text-foreground size-5" aria-hidden />
        {step ? (
          <span className="text-muted-foreground font-mono text-xs tracking-wider">{step}</span>
        ) : null}
      </div>
      <h3 className="text-foreground text-lg font-medium tracking-tight">{title}</h3>
      <p className="text-muted-foreground text-[15px] leading-relaxed">{body}</p>
    </div>
  );
}

function StatBlock({
  value,
  label,
  icon: Icon,
}: {
  value: ReactNode;
  label: ReactNode;
  icon?: typeof Star;
}) {
  return (
    <Panel className="flex flex-col gap-1 p-6">
      {Icon ? <Icon className="text-muted-foreground mb-1 size-4" aria-hidden /> : null}
      <div className="text-foreground text-4xl font-medium tracking-tight tabular-nums">
        {value}
      </div>
      <div className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
        {label}
      </div>
    </Panel>
  );
}

function LetterBg({ seed = 3382 }: { seed?: number }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-0 mask-y-to-95%" aria-hidden>
      <KortixLetterField seed={seed} />
    </div>
  );
}

/* ── Slack conversation mock (matches the official deck) ───────────────── */

function SlackMock() {
  return (
    <Panel className="flex flex-col">
      {/* channel header */}
      <div className="border-border flex items-center justify-between border-b px-4 py-3">
        <span className="text-foreground font-medium tracking-tight">
          <span className="text-muted-foreground">#</span> sales
        </span>
        <span className="text-muted-foreground font-mono text-xs tracking-wider">12 members</span>
      </div>
      {/* messages */}
      <div className="flex flex-col gap-4 p-4">
        <div className="flex gap-3">
          <span className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-sm font-mono text-xs">
            M
          </span>
          <div className="space-y-1">
            <p className="text-foreground text-sm">
              <span className="font-medium">Marco</span>{' '}
              <span className="text-muted-foreground font-mono text-xs">10:24</span>
            </p>
            <p className="text-muted-foreground text-sm leading-relaxed">
              <span className="text-kortix-blue">@Kortix</span> pull last week&rsquo;s pipeline and
              draft follow-ups for the deals that stalled
            </p>
          </div>
        </div>
        <div className="flex gap-3">
          <span className="bg-foreground text-background flex size-7 shrink-0 items-center justify-center rounded-sm">
            <KortixLogo variant="symbol" size={14} />
          </span>
          <div className="space-y-2">
            <p className="text-foreground text-sm">
              <span className="font-medium">Kortix</span>{' '}
              <Badge variant="update" className="rounded px-1.5 py-0 text-[10px]">
                APP
              </Badge>{' '}
              <span className="text-muted-foreground font-mono text-xs">10:24</span>
            </p>
            <p className="text-muted-foreground text-sm leading-relaxed">
              On it. Pulled 14 open deals from HubSpot.
            </p>
            <Bullets
              items={[
                '9 stalled over 7 days, follow-ups drafted',
                '2 missing a next step, flagged for you',
              ]}
            />
            <div className="flex gap-2 pt-1">
              <span className="bg-foreground text-background rounded-sm px-3 py-1 font-mono text-xs">
                Approve &amp; send
              </span>
              <span className="border-border text-muted-foreground rounded-sm border px-3 py-1 font-mono text-xs">
                Review first
              </span>
            </div>
          </div>
        </div>
        <div className="flex gap-3">
          <span className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-sm font-mono text-xs">
            M
          </span>
          <div className="space-y-1">
            <p className="text-foreground text-sm">
              <span className="font-medium">Marco</span>{' '}
              <span className="text-muted-foreground font-mono text-xs">10:25</span>
            </p>
            <p className="text-muted-foreground text-sm leading-relaxed">
              Review first, then send. Nice work.
            </p>
          </div>
        </div>
      </div>
    </Panel>
  );
}

/* ── Use-case wall (every request runs in Slack) ───────────────────────── */

const USE_CASES: [string, string][] = [
  ['sales', 'draft follow-ups for the deals that stalled this week'],
  ['support', 'summarize the open tickets and draft replies'],
  ['finance', 'match these invoices and flag mismatches'],
  ['engineering', "triage today's bugs and assign owners"],
  ['marketing', 'launch the email campaign to the new list'],
  ['people', 'schedule interviews with the shortlist'],
  ['data', 'build the weekly revenue report'],
  ['ops', 'sync new orders to the warehouse'],
  ['sales', 'log this call and move the deal stage'],
  ['finance', 'flag the failed payments from this month'],
  ['product', 'turn this feedback into tracked tickets'],
  ['support', 'answer the customer in the thread'],
  ['it', 'page on-call for the new alert'],
  ['legal', 'draft the contract and route it for review'],
  ['marketing', "schedule this week's posts"],
  ['recruiting', 'screen the new applicants and send replies'],
];

function UseCaseCard({ channel, ask }: { channel: string; ask: string }) {
  return (
    <div className="border-border bg-card flex flex-col gap-2 rounded-sm border p-4">
      <span className="text-muted-foreground font-mono text-xs tracking-wider">#{channel}</span>
      <p className="text-foreground text-sm leading-snug">
        <span className="text-kortix-blue">@Kortix</span> {ask}
      </p>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════ */

export const SLIDES: SlideDef[] = [
  /* 1 — COVER ─────────────────────────────────────────────────────────── */
  {
    id: 'cover',
    label: 'Cover',
    node: (
      <Slide className="overflow-hidden">
        <LetterBg seed={3382} />
        <div className="relative z-10 max-w-4xl space-y-7">
          <KortixLogo variant="logomark" size={30} className="text-foreground" />
          <Badge variant="update" className="rounded">
            A real AI coworker for everyone
          </Badge>
          <h1 className="text-foreground text-5xl leading-[1.08] font-medium tracking-tight md:text-6xl">
            Give everyone their own
            <br />
            <Dim>AI coworker.</Dim>
          </h1>
          <Lead className="max-w-xl text-lg">
            Every employee gets an AI coworker that connects to your tools, works inside Slack, and
            ships real work. Open source, self-hostable, and sharper every time someone shares a
            skill.
          </Lead>
        </div>
      </Slide>
    ),
  },

  /* 2 — WHERE WE COME FROM (SUNA) ─────────────────────────────────────── */
  {
    id: 'origin',
    label: 'Where we come from',
    node: (
      <Slide>
        <SectionHead
          eyebrow="Where we come from"
          title="We launched Suna."
          lead="The first open source AI agent anyone could run. Today it has nearly 20,000 stars on GitHub, more than 400,000 users, and the backing of Microsoft. Kortix is the company we built on top of it."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatBlock icon={Users} value="400K+" label="Users" />
          <StatBlock icon={Star} value="19.8K" label="GitHub stars" />
          <StatBlock icon={Wallet} value="$4M" label="Raised · US" />
          <StatBlock icon={Boxes} value="Microsoft" label="Backed" />
        </div>
        <p className="text-muted-foreground mt-8 font-mono text-xs tracking-wider">
          github.com/kortix-ai/suna
        </p>
      </Slide>
    ),
  },

  /* 3 — SO WHAT IS KORTIX ──────────────────────────────────────────────── */
  {
    id: 'what',
    label: 'So what is Kortix',
    node: (
      <Slide>
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div className="space-y-5">
            <Eyebrow>So what is Kortix?</Eyebrow>
            <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
              A real AI coworker for every employee.
            </h2>
            <Lead>
              Connect your tools, bring your team, and talk to your AI coworker in Slack. It does
              the real work on top of everything your company already knows.
            </Lead>
            <Bullets
              items={['01 — Connect your tools', '02 — Bring your team', '03 — Work in Slack']}
            />
          </div>
          <Shot src={`${SHOT}/01-command-center.png`} alt="Your AI coworker in Kortix" />
        </div>
      </Slide>
    ),
  },

  /* 4 — STEP ONE · CONNECT ─────────────────────────────────────────────── */
  {
    id: 'connect',
    label: 'Step one · Connect',
    node: (
      <Slide>
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div className="space-y-5">
            <Eyebrow>Step one · Connect</Eyebrow>
            <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
              Plug in the tools you already use.
            </h2>
            <Lead>
              Gmail, Slack, Notion, Salesforce, HubSpot, your databases, and thousands more. One
              click each. Your agents work on top of the data that already lives there, so there is
              nothing to move or migrate.
            </Lead>
            <div className="grid gap-3 sm:grid-cols-3">
              <MiniCard label="One-click connect" title="Popular apps" body="Ready to go." />
              <MiniCard label="3,000+ apps" title="Everything" body="Your team touches." />
              <MiniCard label="Or any custom API" title="Bring your own" body="Endpoints." />
            </div>
          </div>
          <Shot
            src={`${SHOT}/03-connectors.png`}
            alt="Kortix connectors"
            url="kortix · connectors"
          />
        </div>
      </Slide>
    ),
  },

  /* 5 — STEP TWO · CONFIGURE ───────────────────────────────────────────── */
  {
    id: 'configure',
    label: 'Step two · Configure',
    node: (
      <Slide>
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <Shot
            src={`${SHOT}/05-agents.png`}
            alt="Kortix agents"
            url="kortix · agents"
            className="order-2 lg:order-1"
          />
          <div className="order-1 space-y-5 lg:order-2">
            <Eyebrow>Step two · Configure</Eyebrow>
            <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
              Agents you shape, skills built in.
            </h2>
            <div className="grid gap-4">
              <IconFeature
                icon={SlidersHorizontal}
                step="SHAPE EVERY AGENT"
                title="Give each one a role"
                body="The tools it can touch, and the way it should work. In plain English, no code."
              />
              <IconFeature
                icon={Star}
                step="70+ SKILLS, READY TO GO"
                title="Account research, outreach, reporting, support triage"
                body="Each skill gets sharper the more tools you connect."
              />
            </div>
          </div>
        </div>
      </Slide>
    ),
  },

  /* 6 — STEP THREE · BRING YOUR TEAM ──────────────────────────────────── */
  {
    id: 'team',
    label: 'Step three · Bring your team',
    node: (
      <Slide>
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div className="space-y-5">
            <Eyebrow>Step three · Bring your team</Eyebrow>
            <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
              Bring your whole team in.
            </h2>
            <Lead>
              Invite teammates by email and set who can do what. People and agents work side by side
              in the same project, on the same shared knowledge, so nothing lives in one
              person&rsquo;s head.
            </Lead>
            <div className="grid gap-3 sm:grid-cols-3">
              <MiniCard label="Invite by email" title="One step" body="To add a teammate." />
              <MiniCard label="Roles and access" title="Manager, editor, viewer" body="" />
              <MiniCard label="Shared by default" title="One project" body="One source of truth." />
            </div>
          </div>
          <Shot src={`${SHOT}/02-team.png`} alt="Kortix members" url="kortix · members" />
        </div>
      </Slide>
    ),
  },

  /* 7 — STEP FOUR · CONNECT TO SLACK ──────────────────────────────────── */
  {
    id: 'slack',
    label: 'Step four · Connect to Slack',
    node: (
      <Slide>
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div className="space-y-5">
            <Eyebrow>Step four · Connect to Slack</Eyebrow>
            <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
              Talk to your AI coworker in Slack.
            </h2>
            <Lead>
              Connect Kortix to Slack and work with your AI coworker where the whole context already
              lives. Mention it, ask in plain language, and it ships the work right there. No new
              app to learn.
            </Lead>
            <div className="flex flex-wrap gap-2">
              <Pill>
                <MessageSquare className="size-3.5" /> Slack — Live
              </Pill>
              <Pill>Microsoft Teams — Coming soon</Pill>
            </div>
          </div>
          <SlackMock />
        </div>
      </Slide>
    ),
  },

  /* 8 — EVERY REQUEST RUNS IN SLACK ───────────────────────────────────── */
  {
    id: 'use-cases',
    label: 'Every request runs in Slack',
    node: (
      <Slide>
        <SectionHead
          eyebrow="Every request runs in Slack"
          title="Hundreds of use cases. One coworker."
          lead="Your whole team just @mentions Kortix in Slack, and it works across the 3,000+ apps they already use."
        />
        <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {USE_CASES.map(([channel, ask], i) => (
            <UseCaseCard key={`${channel}-${i}`} channel={channel} ask={ask} />
          ))}
        </div>
      </Slide>
    ),
  },

  /* 9 — OPEN & YOURS ──────────────────────────────────────────────────── */
  {
    id: 'open',
    label: 'Open & yours',
    node: (
      <Slide>
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div className="space-y-5">
            <Eyebrow>Open &amp; yours</Eyebrow>
            <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
              No lock-in. Fully yours.
            </h2>
            <Lead>
              Your data stays yours. Every action is recorded and easy to review, and a person signs
              off before anything goes out. Run it in the cloud, or on your own systems.
            </Lead>
            <div className="flex flex-wrap gap-2">
              <Pill>Self-hosted or cloud</Pill>
              <Pill>Your keys, your models</Pill>
            </div>
          </div>
          <div className="grid gap-4">
            <IconFeature
              icon={Lock}
              step="OPEN SOURCE"
              title="Built in the open"
              body="No black box, ever."
            />
            <IconFeature
              icon={Eye}
              step="ALWAYS REVIEWABLE"
              title="See exactly what every agent did"
              body="Anytime."
            />
            <IconFeature
              icon={ShieldCheck}
              step="YOU STAY IN CONTROL"
              title="Nothing leaves without a person saying yes"
              body="A human signs off before anything goes out."
            />
            <IconFeature
              icon={Cpu}
              step="BRING YOUR OWN AI"
              title="Our models or yours"
              body="Cloud or self-hosted."
            />
          </div>
        </div>
      </Slide>
    ),
  },

  /* 10 — CLOSING ──────────────────────────────────────────────────────── */
  {
    id: 'closing',
    label: "Let's talk",
    node: (
      <Slide className="overflow-hidden">
        <div className="pointer-events-none absolute inset-0 z-0 mask-y-from-80% mask-x-from-90% opacity-60">
          <KortixGrid count={58} seed={4228} />
        </div>
        <div className="relative z-10 space-y-10">
          <KortixLogo variant="symbol" size={44} className="text-foreground" />
          <div className="space-y-4">
            <h2 className="text-foreground text-5xl font-medium tracking-tight md:text-6xl">
              Let&rsquo;s put your company
              <br />
              <Dim>on autopilot.</Dim>
            </h2>
            <div className="flex flex-wrap items-center gap-3">
              <LabelChip>Talk to sales</LabelChip>
              <span className="text-muted-foreground font-mono text-sm">kortix.com</span>
            </div>
          </div>
          <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
            <Panel className="flex flex-col gap-1 p-6">
              <span className="text-foreground text-lg font-medium tracking-tight">
                Domenico Gagliardi
              </span>
              <span className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
                COO
              </span>
              <p className="text-kortix-blue mt-2 inline-flex items-center gap-2 font-mono text-sm">
                <Mail className="size-3.5" /> dom@kortix.ai
              </p>
              <span className="text-muted-foreground font-mono text-xs">LinkedIn</span>
            </Panel>
            <Panel className="flex flex-col gap-1 p-6">
              <span className="text-foreground text-lg font-medium tracking-tight">
                Marko Kraemer
              </span>
              <span className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
                CEO
              </span>
              <p className="text-kortix-blue mt-2 inline-flex items-center gap-2 font-mono text-sm">
                <Mail className="size-3.5" /> marko@kortix.ai
              </p>
              <span className="text-muted-foreground font-mono text-xs">LinkedIn</span>
            </Panel>
          </div>
        </div>
      </Slide>
    ),
  },
];
