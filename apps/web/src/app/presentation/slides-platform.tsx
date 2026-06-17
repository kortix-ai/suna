'use client';

/**
 * The Kortix deck — the complete story end to end, styled 1:1 with the marketing
 * site (home + /developers + /enterprise). Same components and vocabulary:
 * marketing Button/Badge, mono-uppercase eyebrows, `font-medium tracking-tight`
 * titles, `rounded-sm` thin-border cards on bg-card, lucide icon features, code
 * windows, KortixGrid / KortixLetterField motifs, KortixAsterisk bullets.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import KortixGrid from '@/components/ui/marketing/gridder';
import { KortixLetterField } from '@/components/ui/marketing/kortix-letter-field';
import { cn } from '@/lib/utils';
import {
  ArrowRight,
  Bot,
  Box,
  Boxes,
  Brain,
  Building2,
  Clock,
  Code2,
  Copy,
  FileCode2,
  GitBranch,
  KeyRound,
  Layers,
  MessagesSquare,
  Plug,
  Server,
  Shield,
  Sparkles,
  Store,
  Users,
  Webhook,
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
  Terminal,
} from './parts';

export type SlideDef = { id: string; label: string; node: ReactNode };

const SHOT = '/images/landing-showcase/platform';
const DELIV = '/images/landing-showcase';

/* ── shared local bits ─────────────────────────────────────────────────── */

function IconFeature({
  icon: Icon,
  title,
  body,
  className,
}: {
  icon: typeof Bot;
  title: ReactNode;
  body: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('border-border bg-card flex flex-col gap-3 rounded-sm border p-6', className)}>
      <Icon className="text-foreground size-5" aria-hidden />
      <h3 className="text-foreground text-lg font-medium tracking-tight">{title}</h3>
      <p className="text-muted-foreground text-[15px] leading-relaxed">{body}</p>
    </div>
  );
}

/** Letter-field background wash (hero / closing), exactly like home + enterprise. */
function LetterBg({ seed = 3382 }: { seed?: number }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-0 mask-y-to-95%" aria-hidden>
      <KortixLetterField seed={seed} />
    </div>
  );
}

/** Copy-style hero install chip (static). */
function InstallChip() {
  return (
    <div className="bg-card flex w-full max-w-xl min-w-0 items-center gap-4 rounded-sm border p-3 px-5">
      <div className="flex min-w-0 flex-1 gap-3 overflow-hidden">
        <span className="text-foreground shrink-0 font-mono text-sm">$ </span>
        <span className="text-foreground min-w-0 truncate font-mono text-sm">
          curl -fsSL https://kortix.com/install | bash
        </span>
      </div>
      <Copy className="text-muted-foreground size-4 shrink-0" />
    </div>
  );
}

/* Feature slide: copy + product screenshot, in the home two-column idiom. */
function FeatureSlide({
  eyebrow,
  title,
  lead,
  bullets,
  shot,
  reverse,
}: {
  eyebrow: string;
  title: ReactNode;
  lead: ReactNode;
  bullets: ReactNode[];
  shot: string;
  reverse?: boolean;
}) {
  return (
    <Slide>
      <div
        className={cn(
          'grid items-center gap-10 lg:grid-cols-2 lg:gap-16',
          reverse && 'lg:[&>*:first-child]:order-2',
        )}
      >
        <div className="space-y-5">
          <Eyebrow>{eyebrow}</Eyebrow>
          <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">{title}</h2>
          <Lead>{lead}</Lead>
          <Bullets items={bullets} />
        </div>
        <Shot src={shot} alt={typeof title === 'string' ? title : eyebrow} />
      </div>
    </Slide>
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
        <div className="relative z-10 grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr]">
          <div className="space-y-6">
            <KortixLogo variant="logomark" size={28} className="text-foreground" />
            <Badge variant="update" className="rounded">
              Autonomous Company Operating System
            </Badge>
            <h1 className="text-foreground text-4xl leading-[1.1] font-medium tracking-tight md:text-5xl">
              The AI command center
              <br />
              <Dim>for your company</Dim>
            </h1>
            <Lead className="max-w-xl text-lg">
              One repo. One config. A workforce of AI agents that does the real work — and everything
              is code you own.
            </Lead>
            <InstallChip />
            <div className="flex flex-wrap gap-3 pt-1">
              <Button size="xl">
                Start building
                <ArrowRight className="size-4" />
              </Button>
              <Button size="xl" variant="secondary">
                Talk to sales
              </Button>
            </div>
          </div>
          <Shot src={`${SHOT}/01-command-center.png`} alt="The Kortix command center" />
        </div>
      </Slide>
    ),
  },

  /* 2 — THE THESIS ────────────────────────────────────────────────────── */
  {
    id: 'thesis',
    label: 'The thesis',
    node: (
      <Slide className="overflow-hidden">
        <LetterBg seed={1182} />
        <div className="relative z-10 space-y-8">
          <Eyebrow>The bet</Eyebrow>
          <h2 className="text-foreground max-w-4xl text-4xl leading-[1.1] font-medium tracking-tight sm:text-5xl">
            A company is going to be a git repository.
          </h2>
          <Lead className="max-w-2xl text-lg">
            Not a metaphor — literally something you can clone. Its agents, the skills it has built
            up, the way work gets done, every fact it has learned, and the machines it all runs on.
            Versioned. Diffable. Owned outright.
          </Lead>
          <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
            <Panel className="p-6">
              <Eyebrow>What it is</Eyebrow>
              <p className="text-foreground mt-2 text-xl font-medium tracking-tight">
                The AI command center for your company
              </p>
            </Panel>
            <Panel className="p-6">
              <Eyebrow>In plain language</Eyebrow>
              <p className="text-foreground mt-2 text-xl font-medium tracking-tight">
                A cloud computer where AI agents run your company
              </p>
            </Panel>
          </div>
        </div>
      </Slide>
    ),
  },

  /* 3 — THE PROBLEM ───────────────────────────────────────────────────── */
  {
    id: 'problem',
    label: 'The problem',
    node: (
      <Slide>
        <SectionHead
          eyebrow="Why now"
          title="The models got good. They just can’t remember you."
          lead="You can hand a model a hard problem and it reasons through it better than most people. But every session it wakes up with no idea who you are or what you decided last Tuesday."
        />
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          <MiniCard
            label="The toy"
            title="The tools are demos"
            body="Single-tenant, no isolation, no version history, no real permissions, no security story. They fold the moment a business leans on them."
          />
          <MiniCard
            label="The cage"
            title="The labs rent it back"
            body="Crawl back to a model lab and they’ll host the polished version — and keep your data, your config, and your model on their side of the wall."
          />
          <MiniCard
            label="The refusal"
            title="Kortix is the third option"
            body="A toy or a cage is the actual choice on the table today — and it’s a stupid one. Kortix is what you build when you refuse both."
          />
        </div>
      </Slide>
    ),
  },

  /* 4 — WHAT IT IS ────────────────────────────────────────────────────── */
  {
    id: 'what',
    label: 'What it is',
    node: (
      <Slide>
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div className="space-y-5">
            <Eyebrow>What it is</Eyebrow>
            <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
              Most AI tools give you a chat box.
              <br />
              Kortix gives you a <Dim>command center.</Dim>
            </h2>
            <Lead>
              One place where your agents, skills, integrations, automations, and memory all live —
              and a workforce that produces real output: decks, reports, code, replies, deployed
              work. It feels as simple as a chat app. Underneath, everything is code you own.
            </Lead>
          </div>
          <Panel className="divide-border divide-y">
            {[
              ['Open & yours', 'Open source and self-hostable. Your data, your models, your infra.'],
              ['A workforce, not one assistant', 'Org-scale specialists that run in parallel.'],
              ['Real work, not chat', 'Agents run on real computers and return finished deliverables.'],
              ['Everything is code', 'Versioned, reviewable, portable — grep your entire company.'],
              ['Bring your own models', 'Any provider, your keys, or the subscription you already pay for.'],
            ].map(([t, b]) => (
              <div key={t} className="flex flex-col gap-1 p-5">
                <span className="text-foreground text-base font-medium">{t}</span>
                <span className="text-muted-foreground text-[15px] leading-relaxed">{b}</span>
              </div>
            ))}
          </Panel>
        </div>
      </Slide>
    ),
  },

  /* 5 — ONE COMPANY, ONE REPO ─────────────────────────────────────────── */
  {
    id: 'repo',
    label: 'One repo',
    node: (
      <Slide>
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div className="space-y-5">
            <Eyebrow>Open &amp; code-native</Eyebrow>
            <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
              Your whole company, as code.
            </h2>
            <Lead>
              A Kortix project is a git repo, and that repo <em>is</em> the company. The whole thing
              is defined by two files — everything past that is files you can read and an agent can
              edit.
            </Lead>
            <Bullets
              items={[
                <>
                  <Mono>kortix.toml</Mono> — the Kortix layer: sandbox image, triggers, channels,
                  apps, connectors, required secrets
                </>,
                <>
                  <Mono>.kortix/opencode/</Mono> — the runtime: agents, skills, commands, tools,
                  plugins, models
                </>,
                'Every change versioned, reviewable, reversible',
                'Self-host on your cloud, VPC, or on-prem — no lock-in',
              ]}
            />
          </div>
          <Terminal
            title="kortix.toml"
            lines={[
              { kind: 'comment', text: 'kortix_version = 1' },
              { kind: 'out', text: '' },
              { kind: 'out', text: '[project]' },
              { kind: 'out', text: 'name = "acme"' },
              { kind: 'out', text: '' },
              { kind: 'comment', text: '# a trigger runs itself, on a schedule' },
              { kind: 'out', text: '[[triggers]]' },
              { kind: 'out', text: 'type = "cron"  agent = "research"' },
              { kind: 'out', text: '' },
              { kind: 'comment', text: '# connect a tool’s API as agent tools' },
              { kind: 'out', text: '[[connectors]]' },
              { kind: 'out', text: 'slug = "stripe"  provider = "http"' },
            ]}
          />
        </div>
      </Slide>
    ),
  },

  /* 6 — THE LOOP ──────────────────────────────────────────────────────── */
  {
    id: 'loop',
    label: 'The core loop',
    node: (
      <Slide>
        <SectionHead
          eyebrow="The core loop"
          title="Project → session → sandbox → change request → main."
          lead="Work reaches main only through a change request you approve — so the company self-improves one reviewed change at a time."
        />
        <div className="mt-12 flex flex-wrap items-stretch gap-3">
          {[
            ['project', 'git repo', 'kortix.toml + config'],
            ['session', 'isolated sandbox', 'its own branch'],
            ['agent', 'OpenCode', 'works · commits · pushes'],
            ['change request', 'you review', 'approve to merge'],
            ['main', 'always up', 'self-improves'],
          ].map(([k, t, s], i, arr) => (
            <div key={k as string} className="flex items-center gap-3">
              <Panel className={cn('min-w-[170px] p-4', k === 'change request' && 'bg-foreground text-background')}>
                <span
                  className={cn(
                    'font-mono text-xs tracking-wider uppercase',
                    k === 'change request' ? 'text-background/70' : 'text-muted-foreground',
                  )}
                >
                  {k}
                </span>
                <div className="mt-1 text-lg font-medium tracking-tight">{t}</div>
                <div
                  className={cn(
                    'text-[13px]',
                    k === 'change request' ? 'text-background/70' : 'text-muted-foreground',
                  )}
                >
                  {s}
                </div>
              </Panel>
              {i < arr.length - 1 ? (
                <ArrowRight className="text-muted-foreground/50 size-5 shrink-0" />
              ) : null}
            </div>
          ))}
        </div>
        <Lead className="mt-10 max-w-3xl">
          Every session runs in its own disposable Linux sandbox — the agent can install, run, and
          break anything; only what it commits survives.
        </Lead>
      </Slide>
    ),
  },

  /* 7 — HOW A SESSION WORKS ───────────────────────────────────────────── */
  {
    id: 'session',
    label: 'How a session works',
    node: (
      <Slide>
        <SectionHead
          eyebrow="Under the hood"
          title="Every session is its own machine, on its own branch."
        />
        <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[
            ['01', 'Boot', 'A sandbox boots from one generic snapshot already running the kortix-sandbox-agent-server daemon.'],
            ['02', 'Materialize', 'The daemon clones the repo, cuts a fresh branch, and reads kortix.toml + OpenCode config into a live runtime.'],
            ['03', 'Work, walled off', 'The agent gets a ready machine and works — fully isolated. Run fifty and they never touch each other.'],
            ['04', 'Land it', 'To keep something, it commits and opens a change request toward main. A human decides whether it lands.'],
          ].map(([k, t, b]) => (
            <Panel key={k} className="flex flex-col gap-2 p-6">
              <LabelChip>{k}</LabelChip>
              <h3 className="text-foreground mt-1 text-lg font-medium tracking-tight">{t}</h3>
              <p className="text-muted-foreground text-[15px] leading-relaxed">{b}</p>
            </Panel>
          ))}
        </div>
        <Lead className="mt-10 max-w-3xl">
          A sync engine mirrors sessions into a database so the interface is instant — but the truth
          of any session always lives in the sandbox that ran it.
        </Lead>
      </Slide>
    ),
  },

  /* 8 — PARALLELISM ───────────────────────────────────────────────────── */
  {
    id: 'parallel',
    label: 'Parallelism',
    node: (
      <Slide className="overflow-hidden">
        <LetterBg seed={5521} />
        <div className="relative z-10 space-y-8">
          <Eyebrow>The part nobody else has</Eyebrow>
          <h2 className="text-foreground max-w-4xl text-4xl leading-[1.1] font-medium tracking-tight sm:text-5xl">
            Thousands of agents. One config. <Dim>Zero crossover.</Dim>
          </h2>
          <Lead className="max-w-2xl text-lg">
            Run thousands of agents on the same configuration at once — each boxed off, each feeding
            work back through change requests. When two change the same file, that’s a merge, which
            git has known how to handle for twenty years.
          </Lead>
          <div className="grid max-w-3xl gap-4 sm:grid-cols-3">
            {[
              ['∞', 'parallel sessions, fully isolated'],
              ['1', 'shared config they all run on'],
              ['1 → main', 'reviewed change at a time'],
            ].map(([v, l]) => (
              <Panel key={l} className="p-6">
                <div className="text-foreground text-4xl font-medium tracking-tight tabular-nums">
                  {v}
                </div>
                <div className="text-muted-foreground mt-2 text-[15px]">{l}</div>
              </Panel>
            ))}
          </div>
          <Lead className="text-muted-foreground/80">
            This is the only way an AI workforce is ever more than a slideshow.
          </Lead>
        </div>
      </Slide>
    ),
  },

  /* 9 — COMMAND CENTER OVERVIEW ───────────────────────────────────────── */
  {
    id: 'command-center',
    label: 'Command center',
    node: (
      <Slide>
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div className="space-y-5">
            <SectionHead
              eyebrow="What’s in the command center"
              title="One place your whole AI operation runs from."
            />
            <div className="divide-border border-border bg-card divide-y rounded-sm border">
              {(
                [
                  [Bot, 'Agents', 'Markdown personas with a scoped reach into tools.'],
                  [Sparkles, 'Skills', 'Reusable know-how that rides into every session.'],
                  [Plug, 'Connectors', '3,000+ apps through one scoped token.'],
                  [KeyRound, 'Secrets', 'Encrypted, scoped, never shown to the model.'],
                  [MessagesSquare, 'Channels', 'Slack & chat surfaces, one click.'],
                  [Clock, 'Triggers', 'Cron and signed webhooks spawn sessions.'],
                  [Brain, 'Memory', 'A living company brain that compounds.'],
                ] as [typeof Bot, string, string][]
              ).map(([Icon, t, b]) => (
                <div key={t} className="flex items-center gap-3 px-5 py-3">
                  <Icon className="text-foreground size-4 shrink-0" aria-hidden />
                  <span className="text-foreground text-[15px] font-medium">{t}</span>
                  <span className="text-muted-foreground text-[15px]">— {b}</span>
                </div>
              ))}
            </div>
          </div>
          <Shot src={`${SHOT}/01-command-center.png`} alt="The Kortix command center" />
        </div>
      </Slide>
    ),
  },

  /* 10 — AGENTS */
  {
    id: 'agents',
    label: 'Agents',
    node: (
      <FeatureSlide
        eyebrow="Command center · Agents"
        title="Agents"
        lead="Markdown personas with a prompt and a tightly scoped reach into tools and resources — one per role or task. Installable in one click, and able to rewrite themselves."
        bullets={[
          'A persona is just a markdown file you can read',
          'Scoped permissions per agent — people and agents are principals',
          'Any agent can edit its own config and propose the change',
        ]}
        shot={`${SHOT}/05-agents.png`}
      />
    ),
  },

  /* 11 — SKILLS */
  {
    id: 'skills',
    label: 'Skills',
    node: (
      <FeatureSlide
        reverse
        eyebrow="Command center · Skills"
        title="Skills"
        lead="The part that compounds. Markdown plus scripts that encode how your company gets a specific job done — written once, shared into every session."
        bullets={[
          'Reusable know-how that lives in the repo',
          'Rides into every session automatically',
          'Skills and memory accumulate with every run',
        ]}
        shot={`${SHOT}/04-skills.png`}
      />
    ),
  },

  /* 12 — CONNECTORS */
  {
    id: 'connectors',
    label: 'Connectors',
    node: (
      <FeatureSlide
        eyebrow="Command center · Connectors"
        title="Connect everything, once."
        lead="1-click connect to 3,000+ apps, plus any MCP, OpenAPI, GraphQL, or HTTP service. The sandbox sees all of it through one proxy with a single scoped token — not a drawer full of keys."
        bullets={[
          '3,000+ apps in a click',
          'Bring any MCP, OpenAPI, GraphQL, or HTTP tool',
          'Scoped per person, per agent, per team — and audited',
        ]}
        shot={`${SHOT}/03-connectors.png`}
      />
    ),
  },

  /* 13 — SECRETS */
  {
    id: 'secrets',
    label: 'Secrets',
    node: (
      <Slide>
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div className="space-y-5">
            <Eyebrow>Command center · Secrets</Eyebrow>
            <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
              One token, not ninety.
            </h2>
            <Lead>
              Keys, OAuth, and model credentials live in one governed place: encrypted, scoped per
              person and per group, pushed into the sandbox at runtime without ever showing their
              face — enforceable down at the network. Rotate one credential to revoke everything.
            </Lead>
            <Bullets
              items={[
                'Your API keys never enter a sandbox',
                'Agents act through a single scoped Kortix token',
                'Allow, ask-first, or block — network rules you control',
              ]}
            />
          </div>
          <div className="flex flex-col items-center gap-5">
            <div className="flex flex-wrap justify-center gap-2">
              {['STRIPE_…', 'GITHUB_…', 'OPENAI_…', 'SLACK_…', 'AWS_…', 'LINEAR_…'].map((k) => (
                <span
                  key={k}
                  className="border-border bg-card text-muted-foreground rounded-sm border px-3 py-1.5 font-mono text-xs line-through"
                >
                  {k}
                </span>
              ))}
            </div>
            <ArrowRight className="text-muted-foreground/50 size-5 rotate-90" />
            <div className="bg-foreground text-background rounded-sm px-7 py-4 font-mono text-lg font-medium">
              1 KORTIX_TOKEN
            </div>
            <ArrowRight className="text-muted-foreground/50 size-5 rotate-90" />
            <Pill>sandbox · scoped · audited</Pill>
          </div>
        </div>
      </Slide>
    ),
  },

  /* 14 — CHANNELS */
  {
    id: 'channels',
    label: 'Channels',
    node: (
      <FeatureSlide
        reverse
        eyebrow="Command center · Channels"
        title="Where your people already are."
        lead="Slack, Teams, Telegram, WhatsApp, SMS, email. One click stands up a bot that starts sessions from wherever your team works — same agents, same guardrails, every surface."
        bullets={[
          'One click stands up a bot in your workspace',
          'It starts real sessions from a chat thread',
          'A Slack message can turn into a shipped change request',
        ]}
        shot={`${SHOT}/06-channels.png`}
      />
    ),
  },

  /* 15 — TRIGGERS */
  {
    id: 'triggers',
    label: 'Triggers',
    node: (
      <Slide>
        <SectionHead
          eyebrow="Command center · Triggers"
          title="It runs without you."
          lead="Cron and signed webhooks spawn sessions automatically — fire one every morning, or boot one the instant something happens. The main branch is always up; triggers go off in the night."
        />
        <div className="mt-10 grid gap-6 lg:grid-cols-2">
          <div className="space-y-3">
            <Pill>
              <Clock className="size-3.5" /> Cron
            </Pill>
            <Shot src={`${SHOT}/08-schedules.png`} alt="Scheduled triggers" />
          </div>
          <div className="space-y-3">
            <Pill>
              <Webhook className="size-3.5" /> Webhook
            </Pill>
            <Shot src={`${SHOT}/09-webhooks.png`} alt="Webhook triggers" />
          </div>
        </div>
      </Slide>
    ),
  },

  /* 16 — CHANGE REQUESTS */
  {
    id: 'changes',
    label: 'Change requests',
    node: (
      <FeatureSlide
        eyebrow="How work lands"
        title="Change requests"
        lead="The reviewed merge toward main — and the only way work lands. It’s the equivalent of CI/CD, but for the work of an organization instead of just its code."
        bullets={[
          'Nothing reaches main without a human approving it',
          'Every change — human or agent — is a commit you can diff and revert',
          'The audit trail isn’t bolted on; it’s the repo itself',
        ]}
        shot={`${SHOT}/07-changes.png`}
      />
    ),
  },

  /* 17 — MEMORY */
  {
    id: 'memory',
    label: 'Memory',
    node: (
      <Slide>
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div className="space-y-5">
            <Eyebrow>Command center · Memory</Eyebrow>
            <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
              A living company brain.
            </h2>
            <Lead>
              Files for now, and a system that learns later: chew through every session and every
              connected source and keep a picture of the company that sharpens by the day. Open a
              memory file and see exactly what it believes — nothing is hidden, because there is
              nowhere to hide it.
            </Lead>
            <Bullets
              items={[
                'Plain files today — readable, diffable, versioned',
                'Compounds what it learns over every run',
                'The company gets smarter — and it’s all tracked',
              ]}
            />
          </div>
          <Terminal
            title="memory/customer-acme.md"
            lines={[
              { kind: 'comment', text: '---' },
              { kind: 'out', text: 'name: Acme Corp' },
              { kind: 'out', text: 'plan: Enterprise' },
              { kind: 'out', text: 'renewal: 2026-09-01' },
              { kind: 'comment', text: '---' },
              { kind: 'out', text: '' },
              { kind: 'out', text: 'Prefers async updates. Owner: Dana.' },
              { kind: 'out', text: 'Flagged refund policy Q2 — resolved.' },
            ]}
          />
        </div>
      </Slide>
    ),
  },

  /* 18 — TEAM & PERMISSIONS */
  {
    id: 'team',
    label: 'Team & permissions',
    node: (
      <FeatureSlide
        reverse
        eyebrow="Members, groups & roles"
        title="A workforce you can manage."
        lead="A real account / user / group model where every agent, skill, file, secret, trigger, channel, and connector answers to who is allowed to touch it. People and agents are both principals."
        bullets={[
          'Per-resource permissions for every person and agent',
          'SSO, RBAC, and groups that match your org',
          'Sessions are owned by whoever — or whatever — started them',
        ]}
        shot={`${SHOT}/02-team.png`}
      />
    ),
  },

  /* 19 — THREE WAYS WORK RUNS */
  {
    id: 'modes',
    label: 'Three ways work runs',
    node: (
      <Slide>
        <SectionHead eyebrow="How the work happens" title="Three ways the work runs." />
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {[
            ['On-demand', 'Ask in chat, get it now.', 'You prompt a session and the agent returns the deliverable.'],
            ['Human-assisted', 'It works and checks in.', 'The agent does the work and pauses for the calls that matter.'],
            ['Automated', 'Runs end to end.', 'A schedule or trigger fires a session with no one watching.'],
          ].map(([t, lead, b], i) => (
            <Panel key={t} className={cn('flex flex-col gap-2 p-6', i === 1 && 'bg-foreground text-background')}>
              <span className={cn('font-mono text-xs tracking-wider', i === 1 ? 'text-background/70' : 'text-muted-foreground')}>
                0{i + 1}
              </span>
              <h3 className="mt-1 text-2xl font-medium tracking-tight">{t}</h3>
              <p className={cn('text-[15px] font-medium', i === 1 ? 'text-background' : 'text-foreground')}>{lead}</p>
              <p className={cn('text-[15px] leading-relaxed', i === 1 ? 'text-background/70' : 'text-muted-foreground')}>{b}</p>
            </Panel>
          ))}
        </div>
        <Lead className="mt-8">Policies decide what runs on its own and what waits for a human to say yes.</Lead>
      </Slide>
    ),
  },

  /* 20 — REAL DELIVERABLES */
  {
    id: 'deliverables',
    label: 'Real deliverables',
    node: (
      <Slide>
        <SectionHead
          eyebrow="Real work, not chat"
          title="Agents return finished deliverables."
          lead="Not a transcript — decks, research, datasets, documents, and images, produced on real computers and handed back done. And they take real actions in your tools."
        />
        <div className="mt-12 grid grid-cols-2 gap-4 md:grid-cols-5">
          {[
            ['slides', 'Slides'],
            ['research', 'Research'],
            ['data', 'Data'],
            ['docs', 'Docs'],
            ['images', 'Images'],
          ].map(([f, label]) => (
            <div key={f} className="space-y-2">
              <Shot src={`${DELIV}/${f}.png`} alt={label} chrome={false} />
              <p className="text-muted-foreground text-center font-mono text-xs tracking-wider uppercase">
                {label}
              </p>
            </div>
          ))}
        </div>
      </Slide>
    ),
  },

  /* 21 — START WITH ONE AGENT */
  {
    id: 'use-cases',
    label: 'Start with one agent',
    node: (
      <Slide>
        <SectionHead
          eyebrow="Internal agents"
          title="Start with one useful agent."
          lead="Each is a Kortix project you can configure, deploy, and own."
        />
        <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[
            ['Support', 'A support agent that closes tickets.', 'Drafts a reply from your docs, flags refunds for approval.'],
            ['Engineering', 'An engineering agent that ships fixes.', 'Reviews the PR, opens a fix branch, submits a change request.'],
            ['Research', 'A research agent that briefs your team.', 'Gathers from approved sources and posts a brief before the call.'],
            ['Finance', 'A finance agent that closes the month.', 'Reconciles transactions, flags exceptions, holds for sign-off.'],
            ['Marketing', 'A marketing agent that runs the brief.', 'Turns a brief into drafts, then routes them for review.'],
            ['Operations', 'An operations agent that runs the SOP.', 'Runs each step in a sandbox, pausing at every approval gate.'],
          ].map(([tag, title, body]) => (
            <MiniCard key={tag} label={tag} title={title} body={body} />
          ))}
        </div>
      </Slide>
    ),
  },

  /* 22 — TWO WAYS IN */
  {
    id: 'two-ways',
    label: 'Two ways in',
    node: (
      <Slide>
        <SectionHead eyebrow="Two ways in" title="Builders configure. Teams use." />
        <div className="mt-12 grid gap-4 lg:grid-cols-2">
          <Panel className="space-y-4 p-8">
            <Code2 className="text-foreground size-5" />
            <h3 className="text-foreground text-2xl font-medium tracking-tight">For builders</h3>
            <p className="text-foreground text-[15px]">Configure it like software.</p>
            <Lead className="text-[15px]">
              Define agents, skills, tools, and policies as code. Bring the models and keys you
              already pay for.
            </Lead>
            <Bullets
              index={1}
              items={['Your stack, your models, your keys', 'Skills, tools & policies as code', 'Self-host or managed cloud']}
            />
          </Panel>
          <Panel inverted className="space-y-4 p-8">
            <MessagesSquare className="text-background size-5" />
            <h3 className="text-background text-2xl font-medium tracking-tight">For teams</h3>
            <p className="text-background text-[15px]">Use it like chat.</p>
            <p className="text-background/70 text-[15px] leading-relaxed">
              Give every team agents that feel as simple as a chat app — with guardrails working
              quietly underneath.
            </p>
            <ul className="text-background/80 space-y-2 text-[15px] leading-relaxed">
              {['As easy as a chat app', 'Approvals before agents act', 'Your data and config stay yours'].map((it) => (
                <li key={it} className="flex gap-2">
                  <span className="bg-background/40 mt-2 size-1.5 shrink-0 rounded-full" />
                  <span>{it}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </Slide>
    ),
  },

  /* 23 — EVERY SURFACE */
  {
    id: 'surfaces',
    label: 'Every surface',
    node: (
      <Slide>
        <SectionHead
          eyebrow="Everywhere your team works"
          title="Chat, Slack, Teams, or your own product."
          lead="Your team talks to agents from a clean web and mobile workspace, from Slack or Microsoft Teams, or right inside your own app via the API. Same agents, same guardrails, every surface."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            'Web workspace',
            'Mobile app',
            'Slack',
            'Microsoft Teams',
            'API & SDK',
            'Triggers (cron & webhook)',
          ].map((s) => (
            <div key={s} className="border-border bg-card flex items-center gap-3 rounded-sm border px-6 py-5">
              <span className="bg-foreground size-2 rounded-full" />
              <span className="text-foreground text-[15px] font-medium">{s}</span>
            </div>
          ))}
        </div>
      </Slide>
    ),
  },

  /* 24 — FOR DEVELOPERS */
  {
    id: 'developers',
    label: 'For developers',
    node: (
      <Slide>
        <SectionHead
          eyebrow="For developers"
          title="Built on files you can actually open."
          lead="No SDK to learn, no API maze. Your agents, skills, and tools are plain files — clone the project, change what you want in your editor, and ship it back."
        />
        <div className="mt-10 grid gap-4 lg:grid-cols-2">
          <Terminal
            title="agent.md"
            lines={[
              { kind: 'comment', text: '---' },
              { kind: 'out', text: 'description: Acme’s support agent.' },
              { kind: 'out', text: 'model: anthropic/claude-opus-4-8' },
              { kind: 'comment', text: '---' },
              { kind: 'out', text: '' },
              { kind: 'out', text: 'Resolve customer tickets end to end.' },
              { kind: 'out', text: 'Issue refunds under $500 on your own.' },
              { kind: 'out', text: 'Anything higher goes to a human.' },
            ]}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <IconFeature icon={Boxes} title="Agents are sandboxes" body="Each runs in its own disposable cloud VM, on its own git branch. Spin up thousands in parallel." />
            <IconFeature icon={FileCode2} title="Work is code" body="Agents, skills, triggers, connectors and policies are plain files. Diff, review, roll back." />
            <IconFeature icon={GitBranch} title="kortix init → ship" body="Scaffold a project, then push it live in the cloud with one command." />
            <IconFeature icon={Server} title="You own the stack" body="Open and source-available. Self-host the exact same stack, bring your own keys." />
          </div>
        </div>
      </Slide>
    ),
  },

  /* 25 — SELF-HOST */
  {
    id: 'self-host',
    label: 'Self-host',
    node: (
      <Slide>
        <SectionHead
          eyebrow="Open & self-hostable"
          title="Same product everywhere. Nothing phones home."
          lead="Run Kortix on your own infrastructure — laptop, VPS, your VPC, or fully air-gapped. Start a production-style instance from Docker images, then switch the CLI between Cloud and your own hosts."
        />
        <div className="mt-10 grid items-center gap-6 lg:grid-cols-2">
          <Terminal
            title="self-host"
            lines={[
              { kind: 'cmd', text: 'kortix self-host start' },
              { kind: 'cmd', text: 'kortix hosts use local   # ↔  cloud' },
              { kind: 'comment', text: '# your data, your models, your keys' },
            ]}
          />
          <div className="grid grid-cols-2 gap-4">
            {(
              [
                [Server, 'Managed cloud'],
                [Building2, 'Your VPC'],
                [Box, 'On-prem'],
                [Shield, 'Air-gapped'],
              ] as [typeof Server, string][]
            ).map(([Icon, h], i) => (
              <div
                key={h}
                className={cn(
                  'flex items-center gap-3 rounded-sm border px-5 py-4',
                  i === 0 ? 'border-border bg-foreground text-background' : 'border-border bg-card',
                )}
              >
                <Icon className="size-4" />
                <span className="text-[15px] font-medium">{h}</span>
              </div>
            ))}
          </div>
        </div>
      </Slide>
    ),
  },

  /* 26 — ENTERPRISE & SECURITY */
  {
    id: 'enterprise',
    label: 'Enterprise & security',
    node: (
      <Slide>
        <SectionHead
          eyebrow="Enterprise & security"
          title="The architecture is the security model."
          lead="Built to survive a security review, not slip past one — and you can run all of it on infrastructure you control."
        />
        <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <IconFeature icon={Shield} title="Hard isolation" body="1 session = 1 sandbox = 1 branch. MicroVM-level, thousands in parallel with zero crossover." />
          <IconFeature icon={KeyRound} title="One token" body="Your API keys never enter a sandbox. Rotate one credential to revoke everything." />
          <IconFeature icon={GitBranch} title="Audit everything" body="Every model call logged with cost; every change a git commit you can revert." />
          <IconFeature icon={Building2} title="Own your data" body="Self-host, VPC, on-prem, or air-gapped. SOC 2 Type II in progress." />
        </div>
        <div className="mt-6 flex flex-wrap gap-2">
          {[
            'MicroVM isolation',
            'SSO · RBAC · groups',
            'Per-resource permissions',
            'Secrets manager',
            'Human approval gates',
            'Full audit trail',
            'On-prem / VPC / air-gapped',
          ].map((c) => (
            <Pill key={c}>{c}</Pill>
          ))}
        </div>
      </Slide>
    ),
  },

  /* 27 — WHO IT'S FOR */
  {
    id: 'audiences',
    label: "Who it's for",
    node: (
      <Slide>
        <SectionHead eyebrow="Who it’s for" title="One platform, four ways in." />
        <div className="mt-12 grid gap-4 md:grid-cols-2">
          {(
            [
              [Code2, 'Developers', 'A managed cloud for OpenCode, Claude, and Codex agents. kortix init, kortix ship. Bring the subscription you already pay for; every PR gets a preview you can click through.'],
              [Users, 'Companies', 'A workforce they can actually manage — reached from web, Slack, or Teams — on infrastructure where the data, config, and model belong to the company, not a vendor.'],
              [Shield, 'Enterprise', 'Built to survive a security review: microVM isolation, real members/groups/roles, per-resource permissions, a secrets manager, audit trail, approval gates.'],
              [Building2, 'Agencies & consultancies', 'One horizontal platform sold through verticalized partners with their own front ends and starter templates. A franchise for the part of the economy about to be rebuilt.'],
            ] as [typeof Code2, string, string][]
          ).map(([Icon, t, b]) => (
            <IconFeature key={t} icon={Icon} title={t} body={b} />
          ))}
        </div>
      </Slide>
    ),
  },

  /* 28 — THE BUSINESS */
  {
    id: 'business',
    label: 'The business',
    node: (
      <Slide>
        <SectionHead
          eyebrow="How this becomes a business"
          title="The platform is the proof of the platform."
          lead="We build our own companies on Kortix and let people watch: agents reviewing PRs, a preview per change, a Slack message turning into a shipped PR, outreach and SEO that run themselves."
        />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <IconFeature icon={Code2} title="Open source" body="Self-hostable underneath." />
          <IconFeature icon={Layers} title="Cloud" body="Seats + compute." />
          <IconFeature icon={Shield} title="Single-tenant" body="Run it anywhere they must." />
          <IconFeature icon={Store} title="Marketplace" body="Agents, skills, whole projects." />
          <IconFeature icon={Boxes} title="Platinum.dev" body="The compute floor: CPU & GPU microVMs." />
        </div>
        <Lead className="mt-8 text-muted-foreground/80">
          The labs are paid to lock you in. We only make money if you’d stay anyway.
        </Lead>
      </Slide>
    ),
  },

  /* 29 — CLOSING */
  {
    id: 'closing',
    label: 'Closing',
    node: (
      <Slide className="overflow-hidden">
        <div className="pointer-events-none absolute inset-0 z-0 mask-x-from-90% mask-y-from-80% opacity-60">
          <KortixGrid count={58} seed={4228} />
        </div>
        <div className="relative z-10 space-y-8">
          <KortixLogo variant="symbol" size={40} className="text-foreground" />
          <h2 className="text-foreground max-w-4xl text-4xl leading-[1.12] font-medium tracking-tight sm:text-5xl">
            We’re building the thing that takes a company from human to AGI —{' '}
            <Dim>and lets it keep every byte of itself on the way there.</Dim>
          </h2>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="xl">
              Start building
              <ArrowRight className="size-4" />
            </Button>
            <Button size="xl" variant="secondary" asChild>
              <Link href="/enterprise">Talk to sales</Link>
            </Button>
            <span className="text-muted-foreground ml-1 font-mono text-sm">kortix.com</span>
          </div>
          <p className="text-muted-foreground font-mono text-xs tracking-wider">
            Open source · SSO, RBAC &amp; on-prem · No lock-in
          </p>
        </div>
      </Slide>
    ),
  },
];
