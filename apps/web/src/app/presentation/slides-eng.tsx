'use client';

/**
 * The Kortix deck — content & structure follow the official "Kortix pres ENG"
 * sales narrative (origin → what it is → interface → shared machine →
 * connect/configure/deploy → no model lock-in → Slack/Teams → use cases →
 * thanks), rendered in the marketing-site visual style (home / developers /
 * enterprise): marketing Badge, mono eyebrows, font-medium tracking-tight
 * titles, rounded-sm thin-border cards, KortixAsterisk bullets, KortixGrid /
 * KortixLetterField motifs, real product screenshots.
 */

import type { ReactNode } from 'react';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Badge } from '@/components/ui/badge';
import KortixGrid from '@/components/ui/marketing/gridder';
import { KortixLetterField } from '@/components/ui/marketing/kortix-letter-field';
import { cn } from '@/lib/utils';
import {
  Boxes,
  Briefcase,
  Cpu,
  Database,
  Plug,
  Rocket,
  SlidersHorizontal,
  Star,
  UserRound,
  Users,
  Wallet,
} from 'lucide-react';
import {
  Bullets,
  Dim,
  Eyebrow,
  LabelChip,
  Lead,
  MiniCard,
  Mono,
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
    <div className={cn('border-border bg-card flex flex-col gap-3 rounded-sm border p-6', className)}>
      <div className="flex items-center justify-between">
        <Icon className="text-foreground size-5" aria-hidden />
        {step ? <span className="text-muted-foreground font-mono text-xs tracking-wider">{step}</span> : null}
      </div>
      <h3 className="text-foreground text-lg font-medium tracking-tight">{title}</h3>
      <p className="text-muted-foreground text-[15px] leading-relaxed">{body}</p>
    </div>
  );
}

function StatBlock({ value, label, icon: Icon }: { value: ReactNode; label: ReactNode; icon?: typeof Star }) {
  return (
    <Panel className="flex flex-col gap-1 p-6">
      {Icon ? <Icon className="text-muted-foreground mb-1 size-4" aria-hidden /> : null}
      <div className="text-foreground text-4xl font-medium tracking-tight tabular-nums">{value}</div>
      <div className="text-muted-foreground font-mono text-xs tracking-wider uppercase">{label}</div>
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
            Autonomous Company Operating System
          </Badge>
          <h1 className="text-foreground text-5xl leading-[1.08] font-medium tracking-tight md:text-6xl">
            The AI command center
            <br />
            <Dim>for your company</Dim>
          </h1>
          <Lead className="max-w-xl text-lg">
            One place to build, run, and govern your AI-native company.
          </Lead>
        </div>
      </Slide>
    ),
  },

  /* 2 — ORIGIN STORY ──────────────────────────────────────────────────── */
  {
    id: 'origin',
    label: 'Origin',
    node: (
      <Slide>
        <SectionHead
          eyebrow="How we got here"
          title="April 2025. We launch Suna."
          lead="The first open-source general-purpose AI agent. The project grew to 400,000 users and almost 20,000 stars on GitHub. Microsoft and others invested — and from Suna was born the company now called Kortix."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatBlock icon={Users} value="400K+" label="Users" />
          <StatBlock icon={Star} value="~20K" label="GitHub stars" />
          <StatBlock icon={Wallet} value="$4M" label="Raised · US" />
          <StatBlock icon={Boxes} value="Microsoft" label="via GitHub Fund" />
        </div>
      </Slide>
    ),
  },

  /* 3 — WHAT IS KORTIX TODAY ───────────────────────────────────────────── */
  {
    id: 'what',
    label: 'What is Kortix',
    node: (
      <Slide>
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div className="space-y-5">
            <Eyebrow>So what is Kortix today?</Eyebrow>
            <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
              The AI command center for your company.
            </h2>
            <Lead>
              A command center for the company: you connect the tools, you invite the team members,
              and the AI agents work on your internal data.
            </Lead>
            <Bullets
              items={[
                'Connect the tools your company runs on',
                'Invite the team — people and agents are principals',
                'Agents work on your internal data, in one place',
              ]}
            />
          </div>
          <Shot src={`${SHOT}/01-command-center.png`} alt="The Kortix command center" />
        </div>
      </Slide>
    ),
  },

  /* 4 — PLATFORM INTERFACE OVERVIEW ────────────────────────────────────── */
  {
    id: 'platform',
    label: 'Platform overview',
    node: (
      <Slide>
        <SectionHead eyebrow="Platform" title="Platform interface overview." />
        <div className="mt-10 grid gap-6 lg:grid-cols-3">
          {(
            [
              ['01 · Primary agent interface', `${SHOT}/01-command-center.png`],
              ['02 · Workspace settings', `${SHOT}/02-team.png`],
              ['03 · Agent configuration', `${SHOT}/05-agents.png`],
            ] as [string, string][]
          ).map(([label, src]) => (
            <div key={label} className="space-y-3">
              <LabelChip>{label}</LabelChip>
              <Shot src={src} alt={label} />
            </div>
          ))}
        </div>
      </Slide>
    ),
  },

  /* 5 — A SHARED MACHINE ───────────────────────────────────────────────── */
  {
    id: 'shared-machine',
    label: 'A shared machine',
    node: (
      <Slide>
        <SectionHead
          eyebrow="The model"
          title="A shared machine, where the company's knowledge accumulates over time."
        />
        <div className="mt-12 grid gap-4 lg:grid-cols-2">
          <Panel className="flex flex-col gap-4 p-8">
            <div className="flex items-center gap-3">
              <Database className="text-foreground size-5" />
              <span className="text-muted-foreground font-mono text-xs tracking-wider">01 · SHARED KNOWLEDGE</span>
            </div>
            <h3 className="text-foreground text-2xl font-medium tracking-tight">One environment, one brain.</h3>
            <Lead className="text-[15px]">
              Data, files, credentials, and conversation history all live within the same
              environment. The team queries the system in natural language.
            </Lead>
          </Panel>
          <Panel className="flex flex-col gap-4 p-8">
            <div className="flex items-center gap-3">
              <Users className="text-foreground size-5" />
              <span className="text-muted-foreground font-mono text-xs tracking-wider">02 · WORKFORCE</span>
            </div>
            <h3 className="text-foreground text-2xl font-medium tracking-tight">An agent for every function.</h3>
            <Lead className="text-[15px]">
              On top of this base work the agents the company needs — sales, finance, HR. Each agent
              has its own identity, its own permissions, and its own skills.
            </Lead>
          </Panel>
        </div>
      </Slide>
    ),
  },

  /* 6 — CONNECT · CONFIGURE · DEPLOY ───────────────────────────────────── */
  {
    id: 'how',
    label: 'Connect · Configure · Deploy',
    node: (
      <Slide>
        <SectionHead eyebrow="How it works" title="Connect. Configure. Deploy." />
        <div className="mt-12 grid gap-4 lg:grid-cols-3">
          <IconFeature
            icon={Plug}
            step="01 · CONNECT"
            title="You connect company tools"
            body="Email, CRM, ERP, HR, payroll, drive, repository. 3,000+ native integrations via OAuth, MCP, REST, and CLI — and your proprietary connectors are reusable."
          />
          <IconFeature
            icon={SlidersHorizontal}
            step="02 · CONFIGURE"
            title="Configure agents and automations"
            body="Agents for every function with 60+ built-in skills. Automations trigger on events or schedules, with a shared, growing memory."
          />
          <IconFeature
            icon={Rocket}
            step="03 · DEPLOY"
            title="Agents work autonomously"
            body="24/7 autonomous operation within your infrastructure. Manage via web, mobile, Slack, or Microsoft Teams."
          />
        </div>
      </Slide>
    ),
  },

  /* 7 — NO MODEL LOCK-IN ──────────────────────────────────────────────── */
  {
    id: 'models',
    label: 'No model lock-in',
    node: (
      <Slide>
        <SectionHead
          eyebrow="Models"
          title="No model lock-in."
          lead="The company chooses: use the models included in Kortix, or connect the subscriptions it already has with OpenAI, Anthropic, Google, or other providers. On-prem solution available."
        />
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          <MiniCard label="Configuration" title="Pick your provider" body="Choose the provider from the settings panel." />
          <MiniCard label="Flexibility" title="Switch in real time" body="Switch models in real time without rewriting code." />
          <MiniCard label="Costs" title="Your tokens or ours" body="Use your own tokens, or the plans included with Kortix." />
        </div>
        <div className="mt-8 flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground font-mono text-xs tracking-wider uppercase">Bring</span>
          {['OpenAI', 'Anthropic', 'Google', 'Your own keys', 'On-prem'].map((p) => (
            <Pill key={p}>
              <Cpu className="size-3.5" /> {p}
            </Pill>
          ))}
        </div>
      </Slide>
    ),
  },

  /* 8 — WHERE KORTIX LIVES ────────────────────────────────────────────── */
  {
    id: 'lives',
    label: 'Where Kortix lives',
    node: (
      <Slide>
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div className="space-y-5">
            <Eyebrow>Where Kortix lives</Eyebrow>
            <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
              Inside Slack and Microsoft Teams.
            </h2>
            <Lead>
              Install Kortix as a connector on Slack and Microsoft Teams. The agents reply and work
              inside the same conversations where the team already talks every day.
            </Lead>
            <div className="flex flex-wrap gap-2">
              <Pill>Slack</Pill>
              <Pill>Microsoft Teams</Pill>
              <Pill>Web &amp; mobile</Pill>
            </div>
          </div>
          <Shot src={`${SHOT}/06-channels.png`} alt="Kortix inside Slack and Teams" />
        </div>
      </Slide>
    ),
  },

  /* 9 — USE CASES ─────────────────────────────────────────────────────── */
  {
    id: 'use-cases',
    label: 'Use cases',
    node: (
      <Slide>
        <SectionHead
          eyebrow="Use cases"
          title="Three use cases — personalised for each target."
          lead="Each agent has its own identity, permissions, and skills — configured for the way that team actually works."
        />
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          <IconFeature
            icon={Briefcase}
            step="SALES"
            title="A sales agent"
            body="Researches accounts, drafts personalised outreach, and keeps the CRM current — then holds for sign-off before anything goes out."
          />
          <IconFeature
            icon={Wallet}
            step="FINANCE"
            title="A finance agent"
            body="Reconciles transactions, flags exceptions, and closes the month — every step recorded in an audit trail."
          />
          <IconFeature
            icon={UserRound}
            step="HR"
            title="An HR agent"
            body="Onboards new hires, answers policy questions from your docs, and runs each SOP step by step, pausing at approval gates."
          />
        </div>
      </Slide>
    ),
  },

  /* 10 — CLOSING ──────────────────────────────────────────────────────── */
  {
    id: 'closing',
    label: 'Thank you',
    node: (
      <Slide className="overflow-hidden">
        <div className="pointer-events-none absolute inset-0 z-0 mask-x-from-90% mask-y-from-80% opacity-60">
          <KortixGrid count={58} seed={4228} />
        </div>
        <div className="relative z-10 space-y-8">
          <KortixLogo variant="symbol" size={44} className="text-foreground" />
          <h2 className="text-foreground text-6xl font-medium tracking-tight">Grazie.</h2>
          <div className="space-y-3">
            <Eyebrow>Get in touch</Eyebrow>
            <p className="text-foreground text-xl font-medium tracking-tight">
              Text me at <Mono className="text-kortix-blue">dom@kortix.ai</Mono> — or on LinkedIn.
            </p>
            <p className="text-muted-foreground font-mono text-sm">kortix.com</p>
          </div>
        </div>
      </Slide>
    ),
  },
];
