'use client';

/**
 * How to Kortix: a technical walkthrough. About five minutes, built to present.
 *
 * ── STRUCTURE ────────────────────────────────────────────────────────────
 * Four chapters and nothing else. The spine is on every chapter slide:
 *
 *   01 The repo       `kortix init`: one git repo holds agents, skills, memory
 *                     and kortix.yaml. `kortix ship` deploys it.
 *   02 Connectors     the apps agents call, credentials kept out of the box,
 *                     Allow / Ask / Block per tool
 *   03 The loop       trigger → session → work → main, and back
 *   04 Three loops    a software factory, a GEO/SEO writer, an X bot
 *
 * One machine per chapter. A fifth idea goes on the docs page, not here.
 *
 * ── SOURCE OF TRUTH ──────────────────────────────────────────────────────
 * Every YAML line on a slide is cropped from one project (four agents, four
 * triggers, one connector) that `kortix validate` accepts with exit 0. A line
 * that is only `…` marks a cut. The catalog line is real output of
 * `kortix connectors catalog x` against kortix.com. Keys and behavior:
 * apps/web/content/docs/developers.mdx ("Quickstart", "triggers keys",
 * "Agent keys", "Session branches", "Config comes from the base branch",
 * "Connector rules and approvals"), apps/web/content/docs/guide.mdx
 * ("Triggers") and `kortix loop --help`. Claims:
 * .agents/skills/kortix-brand/references/verbal/claims.md.
 *
 * ── CORRECTIONS TO HOLD ──────────────────────────────────────────────────
 *  1. No "autonomous company", "self-driving" or "the agent deploys".
 *     Session work reaches main through a change request. Merge is
 *     default-deny for agents unless an admin grants `project.gitops.merge`.
 *  2. A cron is 6 fields, seconds first: "0 0 7 * * *" is 07:00 every day.
 *  3. X is the connector catalog's X MCP (`https://api.x.com/mcp`). Composio
 *     removed its X app: never write `provider: composio` for X.
 *  4. Only connector credentials never enter the machine. A granted secret
 *     is an environment value the agent can read (claims.md, Secrets).
 *  5. A session a trigger started waits at most 30 minutes for a person,
 *     then stops. The notes say it where a call waits for approval.
 *  6. Goals (`kortix goals`) is off by default and marked work in progress.
 *     Keep it out until it graduates.
 *  7. No price on any slide.
 *
 * English only, by design: a talk presented live in English. The i18n audit
 * lists this exact file in `ignoredPathParts`.
 */

import { cn } from '@kortix/ui';
import { Badge } from '@kortix/ui/badge';
import type { ReactNode } from 'react';
import type { SlideDef } from '../engine/deck';
import {
  LoopDiagram,
  LoopRing,
  Reveal,
  type LoopDiagramContent,
  type LoopRingContent,
} from '../engine/diagram';
import { Dim, Mono, Panel, Rise, Slide, Spine, Terminal } from '../engine/parts';

/** The whole deck, in four chapters. See the header before you add a fifth. */
const CHAPTERS = ['The repo', 'Connectors', 'The loop', 'Three loops'] as const;

/* ── the validated kortix.yaml, cropped ─────────────────────────────────── */

const TRIGGER_YAML = [
  'triggers:',
  '  - slug: build',
  '    on: { every: 1h }',
  '    run:',
  '      agent: builder',
  '      prompt: Take the next task in backlog/ and ship it.',
] as const;

const CONNECTOR_YAML = [
  'connectors:',
  '  - slug: x',
  '    provider: mcp',
  '    url: https://api.x.com/mcp',
  '…',
  'agents:',
  '  poster:',
  '    prompt_file: agents/poster.md',
  '    skills: [voice]',
  '    connectors: [x]',
  '    …',
] as const;

/** What `kortix init` writes: the starter template (packages/starter/templates/base). */
const REPO: readonly { readonly path: string; readonly body: ReactNode }[] = [
  {
    path: 'kortix.yaml',
    body: 'Agents, triggers, connectors, secret names and the sandbox image. One file.',
  },
  {
    path: 'agents/worker.md',
    body: 'An agent’s prompt. Every new session runs pi, an open-source (MIT) agent harness.',
  },
  {
    path: 'skills/',
    body: 'How your company does each job. Markdown plus scripts.',
  },
  {
    path: 'memory/MEMORY.md',
    body: 'The project memory. Plain files today, read and edited by agents.',
  },
];

const CONNECTORS: readonly { readonly k: string; readonly body: ReactNode }[] = [
  {
    k: 'Reach',
    body: '3,000+ apps in a click, plus MCP, OpenAPI, Postman, GraphQL and raw HTTP.',
  },
  {
    k: 'Credentials',
    body: 'Connector credentials are brokered server-side and never enter the machine.',
  },
  {
    k: 'Rules',
    body: (
      <>
        Allow, Ask or Block, per tool, down to the arguments of each call. On Ask, the call holds
        and the agent’s turn pauses until a person answers.
      </>
    ),
  },
];

const LOOP: LoopDiagramContent = {
  captions: [
    <>
      A trigger in <Mono>kortix.yaml</Mono> fires on a cron schedule, a fixed period, or a signed
      webhook.
    </>,
    'Each fire starts a fresh session on its own sandbox and branch, with the repo’s agents, skills and memory.',
    'The agent works through its connectors and commits what it wants to keep.',
    'The work lands on main. The next fire starts from the new main, with every prompt, skill and memory file that landed.',
  ],
  trigger: { label: 'kortix.yaml', title: 'Trigger', chips: ['cron', 'every', 'webhook'] },
  session: {
    label: 'run.session: fresh',
    title: 'Session',
    chips: ['own sandbox', 'agents · skills · memory'],
  },
  change: { label: 'connectors', title: 'Work', chips: ['calls apps', 'commits'] },
  main: { label: 'main', title: 'Lands', chips: ['next run reads it'] },
  rails: ['fires', 'works', 'lands'],
  back: { label: 'Each fire starts from main', from: 'main', to: 'next session' },
};

type Loop = {
  readonly title: string;
  readonly ring: LoopRingContent;
  readonly on: string;
  readonly line: ReactNode;
};

const LOOPS: readonly Loop[] = [
  {
    title: 'Software factory',
    ring: { cadence: '1h', when: 'every', stations: ['next task', 'code + test', 'review', 'merged'] },
    on: 'on: { every: 1h }',
    line: (
      <>
        A builder takes the next task in <Mono>backlog/</Mono>. A reviewer agent, granted the merge,
        lands it.
      </>
    ),
  },
  {
    title: 'GEO / SEO writer',
    ring: {
      cadence: '07:00',
      when: 'daily',
      stations: ['questions', 'web_search', 'new page', 'site/'],
    },
    on: 'on: { cron: "0 0 7 * * *" }',
    line: 'It finds the question no page of yours answers yet and writes that page.',
  },
  {
    title: 'X bot',
    ring: {
      cadence: '9·13·17',
      when: 'weekdays',
      stations: ['mentions', 'voice skill', 'post', 'remembers'],
    },
    on: 'on: { cron: "0 0 9,13,17 * * 1-5" }',
    line: (
      <>
        Reads mentions through the X connector and posts in your voice.{' '}
        <Mono>session: reuse</Mono> keeps one session, so it remembers what it said.
      </>
    ),
  },
];

/* ── local parts ────────────────────────────────────────────────────────── */

/** Lines of a kortix.yaml crop, set as literal text. A `…` line marks a cut. */
function YamlLines({ lines, className }: { lines: readonly string[]; className?: string }) {
  return (
    <pre className={cn('font-mono leading-relaxed', className)}>
      {lines.map((line, i) => (
        <span
          key={i}
          className={cn(
            'block',
            line.trim() === '…' ? 'text-muted-foreground' : 'text-foreground',
          )}
        >
          {line}
        </span>
      ))}
    </pre>
  );
}

/** A kortix.yaml crop with its file name, the artifact the reader keeps. */
function Yaml({
  lines,
  className,
  textClassName = 'text-sm',
}: {
  lines: readonly string[];
  className?: string;
  textClassName?: string;
}) {
  return (
    <div className={cn('border-border bg-background overflow-hidden rounded-sm border', className)}>
      <p className="border-border text-muted-foreground border-b px-4 py-2 font-mono text-xs">
        kortix.yaml
      </p>
      <YamlLines lines={lines} className={cn('p-5', textClassName)} />
    </div>
  );
}

/**
 * A chapter slide: the spine, one short title, and the machine. No lead
 * paragraph: on a build slide the words that change are the caption, and a
 * second block of prose competes with the narration.
 */
function Chapter({ n, title, children }: { n: number; title: ReactNode; children: ReactNode }) {
  return (
    <Slide innerClassName="py-14 sm:py-16">
      <Rise i={0}>
        <Spine chapters={CHAPTERS} active={n} />
      </Rise>
      <Rise i={1}>
        <h2 className="text-foreground mt-6 max-w-4xl text-3xl font-medium tracking-tight text-balance">
          {title}
        </h2>
      </Rise>
      <Rise i={2}>
        <div className="mt-8">{children}</div>
      </Rise>
    </Slide>
  );
}

export function useSlides(): SlideDef[] {
  return [
    /* ── open ────────────────────────────────────────────────────────────── */
    {
      id: 'title',
      label: 'How to Kortix',
      notes:
        'Hi, we are Kortix. In the next five minutes I will show you how to put agents in a loop.\n\nThe whole idea fits on this screen. These six lines live in a file called kortix.yaml. Every hour, Kortix starts a fresh session of an agent called builder and tells it to take the next task and ship it.\n\nKortix is an open-source CompanyOS. Your company is a git repository, and agents work inside it. Four parts. Let me show you.',
      node: (
        <Slide>
          <Rise i={0}>
            <Badge variant="kortix" className="rounded">
              Kortix CompanyOS
            </Badge>
          </Rise>
          <Rise i={1}>
            <h1 className="text-foreground mt-6 max-w-4xl text-4xl font-medium tracking-tight text-balance sm:text-5xl lg:text-6xl">
              How to Kortix.{' '}
              <span className="block">
                <Dim>Put your agents in a loop.</Dim>
              </span>
            </h1>
          </Rise>
          <Rise i={2}>
            <Yaml lines={TRIGGER_YAML} className="mt-10 max-w-2xl" textClassName="text-base sm:text-lg" />
          </Rise>
          <Rise i={3}>
            <p className="text-muted-foreground mt-6 max-w-2xl text-lg leading-relaxed">
              Kortix runs this from your repository. Every hour, a fresh session starts on its own
              sandbox and its own branch.
            </p>
          </Rise>
        </Slide>
      ),
    },

    /* ── 01 · the repo ───────────────────────────────────────────────────── */
    {
      id: 'repo',
      label: 'The repo',
      steps: 4,
      notes: [
        'One. The repo. kortix init makes a new folder and runs git init. Everything your agents are lives in this one repository, as text. A company you can clone.',
        'kortix.yaml is the Kortix layer: your agents, your triggers, your connectors, the names of your secrets, and the sandbox image every session boots.',
        'agents holds each agent’s prompt. Every new session runs pi, an open-source agent harness, with that prompt.',
        'skills is how your company does each job, as markdown and scripts. memory is the project memory, plain files the agents read and edit.',
        'And then one command. kortix ship validates the file, commits, asks for any missing secrets, pushes, and connects the connectors you declared. The first time, it creates the project. That is the deploy. Change a file, ship again.',
      ],
      node: (step) => (
        <Chapter
          n={0}
          title={
            <>
              <Mono>kortix init</Mono> makes a git repo. <Dim>The repo is the company.</Dim>
            </>
          }
        >
          <div className="grid gap-6 lg:grid-cols-5">
            <div className="border-border bg-card overflow-hidden rounded-sm border lg:col-span-3">
              <p className="border-border text-muted-foreground border-b px-5 py-3 font-mono text-sm">
                <span className="text-foreground">$ kortix init my-company</span>
                <span> · git init -b main</span>
              </p>
              {REPO.map((row, i) => (
                <Reveal key={row.path} on={step >= i}>
                  <div
                    className={cn(
                      'border-border grid gap-2 px-5 py-4 sm:grid-cols-12 sm:gap-6',
                      i > 0 && 'border-t',
                    )}
                  >
                    <p className="text-foreground font-mono text-lg sm:col-span-5">{row.path}</p>
                    <p className="text-muted-foreground text-sm leading-relaxed sm:col-span-7">
                      {row.body}
                    </p>
                  </div>
                </Reveal>
              ))}
            </div>
            <div className="lg:col-span-2">
              <Reveal on={step >= 4} className="flex h-full flex-col gap-4">
                <Terminal lines={[{ kind: 'cmd', text: 'kortix ship' }]} />
                <Panel className="flex-1 p-5">
                  <p className="text-foreground text-lg font-medium tracking-tight">
                    One command deploys it.
                  </p>
                  <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
                    <Mono>kortix ship</Mono> validates <Mono>kortix.yaml</Mono>, commits, asks for
                    missing secrets, pushes, and connects the declared connectors. The first run
                    creates the project.
                  </p>
                </Panel>
              </Reveal>
            </div>
          </div>
        </Chapter>
      ),
    },

    /* ── 02 · connectors ─────────────────────────────────────────────────── */
    {
      id: 'connectors',
      label: 'Connectors',
      steps: 2,
      notes: [
        'Two. Connectors. This is what turns an agent into something that does real work. A connector is a few lines in kortix.yaml, and each agent names the connectors it may call. Here, the poster agent gets X, and nothing else.',
        'Where do they come from? The catalog. Over three thousand apps in a click, plus any MCP server, OpenAPI or Postman spec, GraphQL endpoint or raw HTTP API. kortix connectors catalog finds one; this is the real answer for X.',
        'Two things make it safe to leave running. Connector credentials are brokered on our side and never enter the machine the model drives. And every tool gets a rule: allow, ask or block, down to the arguments. On ask, the call holds and the turn pauses. One catch for scheduled runs: a session a trigger started waits at most thirty minutes for a person, then stops.',
      ],
      node: (step) => (
        <Chapter n={1} title="Connectors give agents real reach. Credentials stay outside the box.">
          <div className="grid gap-6 lg:grid-cols-5">
            <div className="flex flex-col gap-4 lg:col-span-3">
              <Yaml lines={CONNECTOR_YAML} />
              <Reveal on={step >= 1}>
                <Terminal
                  lines={[
                    { kind: 'cmd', text: 'kortix connectors catalog x' },
                    { kind: 'out', text: 'curated/x-com-openapi   X   REST API   The X API exposes posts…' },
                    { kind: 'out', text: 'Ways to connect: x-mcp  MCP  X MCP (recommended)' },
                  ]}
                />
              </Reveal>
            </div>
            <div className="border-border bg-card overflow-hidden rounded-sm border lg:col-span-2">
              {CONNECTORS.map((c, i) => (
                <Reveal key={c.k} on={step >= (i === 0 ? 1 : 2)}>
                  <div className={cn('border-border px-5 py-5', i > 0 && 'border-t')}>
                    <p className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
                      {c.k}
                    </p>
                    <p className="text-foreground mt-2 text-base leading-relaxed">{c.body}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </Chapter>
      ),
    },

    /* ── 03 · the loop ───────────────────────────────────────────────────── */
    {
      id: 'loop',
      label: 'The loop',
      steps: 3,
      notes: [
        'Three. The loop. It starts with a trigger in kortix.yaml. It fires on a cron schedule, a fixed period, or a signed webhook.',
        'Every fire starts a fresh session, on its own sandbox and its own branch, with the agents, skills and memory from the repo.',
        'The agent does the work through its connectors, and commits what it wants to keep.',
        'The work lands on main. And this is what makes it a loop: the next fire starts from the new main. If the agent improved a skill or wrote down what it learned, the next run has it.',
      ],
      node: (step) => (
        <Chapter n={2} title="A loop has four parts. The last one feeds the first.">
          <LoopDiagram step={step} content={LOOP} />
        </Chapter>
      ),
    },

    /* ── 04 · three loops ────────────────────────────────────────────────── */
    {
      id: 'loops',
      label: 'Three loops',
      steps: 2,
      notes: [
        'Four. Three loops you can build today. First, a software factory. Every hour, a builder takes the next task from the backlog folder and writes the code and a test. A reviewer agent, which an admin granted the merge, reads it and lands it.',
        'Second, GEO and SEO. Every morning at seven, a writer runs web search on the questions your buyers ask, finds the one no page of yours answers yet, and writes that page.',
        'Third, an X bot. Weekdays at nine, one and five, it reads mentions through the X connector and posts in your voice, from a voice skill. session reuse keeps one session across fires, so it remembers what it already said.',
      ],
      node: (step) => (
        <Chapter n={3} title="Three loops you can build today.">
          <div className="grid gap-10 lg:grid-cols-3">
            {LOOPS.map((loop, i) => (
              <Reveal key={loop.title} on={step >= i}>
                <div className="flex flex-col items-center text-center">
                  <LoopRing content={loop.ring} spin={step === i} />
                  <h3 className="text-foreground mt-6 text-2xl font-medium tracking-tight">
                    {loop.title}
                  </h3>
                  <p className="text-muted-foreground mt-2 font-mono text-xs">{loop.on}</p>
                  <p className="text-muted-foreground mt-3 max-w-xs text-sm leading-relaxed">
                    {loop.line}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </Chapter>
      ),
    },

    /* ── close ───────────────────────────────────────────────────────────── */
    {
      id: 'start',
      label: 'Start',
      notes:
        'So: start with one loop. Install the CLI, log in, kortix init, kortix ship. On the free plan, connect your own model key or your ChatGPT subscription first.\n\nAnd inside a session, kortix loop prompts that same session again on a schedule. It never starts a new one. Use it for things like: is CI green yet.\n\nEverything I showed you is open source. Read it, fork it, audit it.\n\nKortix. Your CompanyOS.',
      node: (
        <Slide>
          <Rise i={0}>
            <h2 className="text-foreground max-w-4xl text-3xl font-medium tracking-tight text-balance sm:text-5xl">
              Start with one loop.
            </h2>
          </Rise>
          <div className="mt-10 grid gap-4 lg:grid-cols-2">
            <Rise i={1}>
              <Terminal
                lines={[
                  { kind: 'cmd', text: 'curl -fsSL https://kortix.com/install | bash' },
                  { kind: 'cmd', text: 'kortix login' },
                  { kind: 'cmd', text: 'kortix init my-company' },
                  { kind: 'cmd', text: 'cd my-company && kortix ship' },
                ]}
              />
            </Rise>
            <Rise i={2}>
              <div className="flex h-full flex-col gap-3">
                <Terminal
                  title="inside a session"
                  lines={[
                    { kind: 'cmd', text: 'kortix loop "Is CI green? Fix it if not." --every 30m' },
                  ]}
                />
                <p className="text-muted-foreground text-sm leading-relaxed">
                  A loop prompts the same session again. A trigger starts a new one.
                </p>
              </div>
            </Rise>
          </div>
          <Rise i={3}>
            <div className="border-border mt-10 flex flex-col gap-2 border-t pt-6">
              <p className="text-muted-foreground text-base leading-relaxed">
                On Free, connect your own model key or a ChatGPT subscription first.
              </p>
              <p className="text-foreground text-base leading-relaxed">
                Open source. Read it, fork it, audit it.{' '}
                <Mono className="text-muted-foreground">github.com/kortix-ai/CompanyOS</Mono>
                <span className="text-muted-foreground"> · </span>
                <Mono className="text-muted-foreground">kortix.com/docs/developers</Mono>
              </p>
            </div>
          </Rise>
        </Slide>
      ),
    },
  ];
}
