'use client';

/**
 * How to Kortix: a technical walkthrough. About five minutes, built to present.
 *
 * ── STRUCTURE ────────────────────────────────────────────────────────────
 * Four chapters and nothing else. The bottom bar names the chapter:
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
 * The cover and the start slide are the path a person runs, verified end to
 * end on 2026-11-07 against a local stack with a real Platinum sandbox:
 * `kortix init` (agent `worker`), the cover trigger pasted into kortix.yaml,
 * one task in backlog/, `kortix ship`, `kortix triggers fire build`. The
 * session did the task, wrote memory and opened a change request; after the
 * merge the next fire read that memory. The other YAML crops come from one
 * project (four agents, four triggers, one connector) that `kortix validate`
 * accepts with exit 0. A line
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
 * Frame: engine/frame.tsx, the landing page at 16:9. No eyebrow, no kicker.
 *
 * English only, by design: a talk presented live in English. The i18n audit
 * lists this exact file in `ignoredPathParts`.
 */

import type { ReactNode } from 'react';
import type { SlideDef } from '../engine/deck';
import {
  LoopDiagram,
  LoopRing,
  type LoopDiagramContent,
  type LoopRingContent,
} from '../engine/diagram';
import { Cell, Cells, Code, Mono, Reveal, Rows, Slide } from '../engine/frame';

/* ── the validated kortix.yaml, cropped ─────────────────────────────────── */

const TRIGGER_YAML = [
  'triggers:',
  '  - slug: build',
  '    on: { every: 1h }',
  '    run:',
  '      agent: worker',
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

const START_SHELL = [
  '$ curl -fsSL https://kortix.com/install | bash',
  '$ kortix login',
  '$ kortix init my-company && cd my-company',
  '# paste the trigger into kortix.yaml',
  '$ mkdir backlog && echo "Add a CHANGELOG" > backlog/0001.md',
  '$ kortix ship',
  '$ kortix triggers fire build',
] as const;

export function useSlides(): SlideDef[] {
  return [
    /* ── open ────────────────────────────────────────────────────────────── */
    {
      id: 'title',
      label: 'How to Kortix',
      notes:
        'Hi, we are Kortix. In the next five minutes I will show you how to put agents in a loop.\n\nThe whole idea fits on this screen. These six lines live in a file called kortix.yaml. Every hour, Kortix starts a fresh session of worker, the agent every new project starts with, and tells it to take the next task and ship it.\n\nKortix is an open-source CompanyOS. Your company is a git repository, and agents work inside it. Four parts. Let me show you.',
      node: (
        <Slide
          size="cover"
          title="How to Kortix."
          titleMuted="Put your agents in a loop."
          sub="Kortix runs this from your repository. Every hour, a fresh session starts on its own sandbox and its own branch."
        >
          <Code
            title="kortix.yaml"
            lines={TRIGGER_YAML}
            className="max-w-3xl"
            textClassName="text-base lg:text-lg"
          />
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
        <Slide
          title={
            <>
              <Mono>kortix init</Mono> makes a git repo.
            </>
          }
          titleMuted="The repo is the company."
        >
          <div className="grid gap-6 lg:grid-cols-12">
            <Rows
              className="lg:col-span-8"
              upTo={step}
              rows={REPO.map((row) => ({
                id: row.path,
                k: <Mono className="text-lg">{row.path}</Mono>,
                v: row.body,
              }))}
            />
            <Reveal on={step >= 4} className="flex flex-col gap-4 lg:col-span-4">
              <Code title="zsh" lines={['$ kortix ship']} />
              <Cells>
                <Cell title="One command deploys it.">
                  <Mono>kortix ship</Mono> validates <Mono>kortix.yaml</Mono>, commits, asks for
                  missing secrets, pushes, and connects the declared connectors. The first run
                  creates the project.
                </Cell>
              </Cells>
            </Reveal>
          </div>
        </Slide>
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
        <Slide title="Connectors give agents real reach." titleMuted="Credentials stay outside the box.">
          <div className="grid gap-6 lg:grid-cols-12">
            <div className="flex flex-col gap-4 lg:col-span-7">
              <Code title="kortix.yaml" lines={CONNECTOR_YAML} />
              <Reveal on={step >= 1}>
                <Code
                  title="zsh"
                  lines={[
                    '$ kortix connectors catalog x',
                    'curated/x-com-openapi   X   REST API   The X API exposes posts…',
                    'Ways to connect: x-mcp  MCP  X MCP (recommended)',
                  ]}
                  textClassName="text-xs lg:text-sm"
                />
              </Reveal>
            </div>
            <Cells className="lg:col-span-5">
              {CONNECTORS.map((c, i) => (
                <Cell key={c.k} label={c.k} on={step >= (i === 0 ? 1 : 2)}>
                  <span className="text-foreground text-base">{c.body}</span>
                </Cell>
              ))}
            </Cells>
          </div>
        </Slide>
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
        <Slide title="A loop has four parts." titleMuted="The last one feeds the first.">
          <LoopDiagram step={step} content={LOOP} />
        </Slide>
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
        <Slide title="Three loops you can build today." bandClassName="lg:py-8">
          <Cells className="lg:grid-cols-3">
            {LOOPS.map((loop, i) => (
              <div key={loop.title} className="bg-background p-6 lg:p-8">
                <Reveal on={step >= i} className="flex flex-col items-center text-center">
                  <LoopRing content={loop.ring} spin={step === i} />
                  <h3 className="text-foreground mt-5 text-xl font-medium tracking-tight">
                    {loop.title}
                  </h3>
                  <p className="text-muted-foreground mt-2 font-mono text-xs">{loop.on}</p>
                  <p className="text-muted-foreground mt-3 max-w-xs text-sm leading-relaxed text-pretty">
                    {loop.line}
                  </p>
                </Reveal>
              </div>
            ))}
          </Cells>
        </Slide>
      ),
    },

    /* ── close ───────────────────────────────────────────────────────────── */
    {
      id: 'start',
      label: 'Start',
      notes:
        'So: start with one loop. Install the CLI and log in. kortix init, paste the trigger into kortix.yaml, put one task in a backlog folder, and kortix ship. Then kortix triggers fire build runs it now instead of in an hour. On the free plan, connect your own model key or your ChatGPT subscription first.\n\nAnd inside a session, kortix loop prompts that same session again on a schedule. It never starts a new one. Use it for things like: is CI green yet.\n\nEverything I showed you is open source. Read it, fork it, audit it.\n\nKortix. Your CompanyOS.',
      node: (
        <Slide
          title="Start with one loop."
          titleMuted="Open source. Read it, fork it, audit it."
          sub="On Free, connect your own model key or a ChatGPT subscription first."
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <Code title="zsh" lines={START_SHELL} />
            <div className="flex flex-col gap-4">
              <Code
                title="inside a session"
                lines={['$ kortix loop "Is CI green? Fix it if not." --every 30m']}
              />
              <p className="text-muted-foreground text-sm">
                A loop prompts the same session again. A trigger starts a new one.
              </p>
            </div>
          </div>
          <p className="text-muted-foreground mt-8 text-sm">
            <Mono className="text-foreground">github.com/kortix-ai/CompanyOS</Mono>
            <span> · </span>
            <Mono className="text-foreground">kortix.com/docs/developers</Mono>
          </p>
        </Slide>
      ),
    },
  ];
}
