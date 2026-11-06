'use client';

/**
 * How to Kortix: the Frontier Hackathon talk. Technical, about five minutes.
 *
 * ── STRUCTURE ────────────────────────────────────────────────────────────
 * Four chapters and nothing else. The spine is on every chapter slide:
 *
 *   01 The loop     trigger → session → change request → main, and back
 *   02 The file     the agent block, the trigger, `kortix ship`
 *   03 Three loops  a software factory, a GEO/SEO writer, an X bot
 *   04 The gate     where a person approves: each call, each merge, or a grant
 *
 * One machine per chapter. A fifth idea goes on the docs page, not here.
 *
 * ── SOURCE OF TRUTH ──────────────────────────────────────────────────────
 * Every YAML line on a slide is cropped from one project (four agents, four
 * triggers, one connector) that `kortix validate` accepts with exit 0. A line
 * that is only `…` marks a cut. Keys and behavior:
 * apps/web/content/docs/developers.mdx ("triggers keys", "Agent keys",
 * "Session branches", "Config comes from the base branch", "Agents that
 * merge", "Connector rules and approvals"), apps/web/content/docs/guide.mdx
 * ("Triggers") and `kortix loop --help`. Claims:
 * .agents/skills/kortix-brand/references/verbal/claims.md.
 *
 * ── CORRECTIONS TO HOLD ──────────────────────────────────────────────────
 *  1. No "autonomous company", "self-driving" or "deploys". Session work
 *     reaches main through a change request. Merge is default-deny for
 *     agents unless an admin grants `project.gitops.merge`.
 *  2. A cron is 6 fields, seconds first: "0 0 7 * * *" is 07:00 every day.
 *  3. X is the connector catalog's X MCP (`https://api.x.com/mcp`). Composio
 *     removed its X app: never write `provider: composio` for X.
 *  4. A session a trigger started waits at most 30 minutes for a person,
 *     then stops. The notes say it wherever a slide holds a call.
 *  5. Goals (`kortix goals`) is off by default and marked work in progress.
 *     Keep it out until it graduates.
 *  6. No price on any slide. The FRONTIER code's amount stays off it too.
 *  7. FRONTIER credits pay for compute on every plan. They do not unlock
 *     managed models on Free (apps/api/src/billing/services/credit-codes.ts),
 *     so the Free line about a model key stays next to the code. The code
 *     works on kortix.com only after a person creates it on prod.
 *
 * English only, by design: one live event, presented in English. The i18n
 * audit lists this exact file in `ignoredPathParts`.
 */

import { cn } from '@kortix/ui';
import { Badge } from '@kortix/ui/badge';
import type { ReactNode } from 'react';
import type { SlideDef } from '../engine/deck';
import { LoopDiagram, Reveal, type LoopDiagramContent } from '../engine/diagram';
import { Dim, Mono, Panel, Rise, Slide, Spine, Terminal } from '../engine/parts';

/** The whole deck, in four chapters. See the header before you add a fifth. */
const CHAPTERS = ['The loop', 'The file', 'Three loops', 'The gate'] as const;

/* ── the validated kortix.yaml, cropped ─────────────────────────────────── */

const TRIGGER_YAML = [
  'triggers:',
  '  - slug: build',
  '    on: { every: 1h }',
  '    run:',
  '      agent: builder',
  '      prompt: Take the next task in backlog/ and ship it.',
] as const;

const AGENT_YAML = [
  'agents:',
  '  builder:',
  '    prompt_file: agents/builder.md',
  '    skills: [backlog]',
  '    kortix_permissions: [project.gitops.push]',
  '    workspace: { project_repository: true }',
  '    …',
] as const;

const LOOP: LoopDiagramContent = {
  captions: [
    <>
      A trigger in <Mono>kortix.yaml</Mono> fires on a cron schedule, a fixed period, or a signed
      webhook.
    </>,
    'Each fire starts a fresh session. It gets its own sandbox and its own branch, cut from main.',
    'The agent works there. When it wants to keep something, it opens a change request.',
    'The change request merges. The next fire starts from the new main, with every prompt and skill that merged.',
  ],
  trigger: { label: 'kortix.yaml', title: 'Trigger', chips: ['cron', 'every', 'webhook'] },
  session: {
    label: 'run.session: fresh',
    title: 'Session',
    chips: ['own sandbox', 'own branch'],
  },
  change: { label: 'kortix cr open', title: 'Change request', chips: ['a diff to review'] },
  main: { label: 'main', title: 'Merged', chips: ['a person', 'or a merge grant'] },
  rails: ['fires', 'commits', 'merges'],
  back: { label: 'Each fire starts from main', from: 'main', to: 'next session' },
};

type Tone = 'ok' | 'held';

type Loop = {
  readonly title: string;
  readonly yaml: readonly string[];
  readonly does: ReactNode;
  readonly gate: ReactNode;
  readonly tone: Tone;
};

const LOOPS: readonly Loop[] = [
  {
    title: 'Software factory',
    yaml: [
      '- slug: build',
      '  on: { every: 1h }',
      '  …',
      '- slug: review',
      '  on: { every: 15m }',
      '  …',
    ],
    does: (
      <>
        The builder takes the oldest task in <Mono>backlog/</Mono>, writes the code and a test, and
        opens a change request. The reviewer reads every open one.
      </>
    ),
    gate: (
      <>
        The reviewer holds <Mono>project.gitops.merge</Mono>. It merges or requests changes.
      </>
    ),
    tone: 'ok',
  },
  {
    title: 'GEO / SEO writer',
    yaml: ['- slug: geo', '  on: { cron: "0 0 7 * * *" }', '  …'],
    does: (
      <>
        At 07:00 it runs <Mono>web_search</Mono> on each question in{' '}
        <Mono>site/questions.md</Mono> and notes who gets cited. It writes the page for one
        question no page answers.
      </>
    ),
    gate: 'A change request with the new page. A person approves it.',
    tone: 'held',
  },
  {
    title: 'X bot',
    yaml: [
      '- slug: post',
      '  on: { cron: "0 0 9,13,17 * * 1-5" }',
      '  run:',
      '    session: reuse',
      '    …',
    ],
    does: (
      <>
        Weekdays at 09:00, 13:00 and 17:00 it reads mentions through the X connector, then replies
        or posts. <Mono>reuse</Mono> keeps one session, so it remembers what it said.
      </>
    ),
    gate: (
      <>
        <Mono>default_mode: risk</Mono>. A read runs. Each post waits for approval.
      </>
    ),
    tone: 'held',
  },
];

type Gate = {
  readonly where: string;
  readonly yaml: readonly string[];
  readonly body: string;
  readonly tone: Tone;
};

const GATES: readonly Gate[] = [
  {
    where: 'Each call',
    yaml: ['policy:', '  default_mode: risk'],
    body: 'A read runs. A write or a delete waits for approval. The turn pauses, then resumes.',
    tone: 'held',
  },
  {
    where: 'Each change request',
    yaml: ['kortix_permissions: [project.gitops.push]'],
    body: 'No merge grant, no merge: merge is default-deny for agents. A person approves the change request.',
    tone: 'held',
  },
  {
    where: 'An agent you granted',
    yaml: ['kortix_permissions:', '  - project.gitops.merge', '  - project.review.act'],
    body: 'An admin grants the reviewer the merge. It merges what the builder opened. It cannot grant itself more.',
    tone: 'ok',
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

/** A verdict: the hue on the dot, the words in ink (color.md, deck verdicts). */
function Verdict({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <div className="text-foreground flex items-start gap-2.5 text-sm leading-relaxed">
      <span
        aria-hidden
        className={cn(
          'mt-1.5 size-2 shrink-0 rounded-full',
          tone === 'ok' ? 'bg-kortix-green' : 'bg-kortix-orange',
        )}
      />
      <div>{children}</div>
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
        'Hi, we are Kortix. In the next five minutes I will show you how to put agents in a loop.\n\nThe whole idea fits on this screen. These six lines live in a file called kortix.yaml. Every hour, Kortix starts a fresh session of an agent called builder and tells it to take the next task and ship it.\n\nKortix is an open-source CompanyOS. Your company is a git repository, and agents work inside it. A loop has four parts. Let me draw them.',
      node: (
        <Slide>
          <Rise i={0}>
            <Badge variant="kortix" className="rounded">
              Frontier Hackathon
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

    /* ── 01 · the loop ───────────────────────────────────────────────────── */
    {
      id: 'loop',
      label: 'The loop',
      steps: 3,
      notes: [
        'One. The loop. It starts with a trigger. A trigger lives in kortix.yaml, and it fires on a cron schedule, a fixed period, or a signed webhook.',
        'Every fire starts a fresh session. The session gets its own sandbox, a real cloud computer, and its own branch, cut from main. Two sessions never share a machine or a branch.',
        'Each session gets its own sandbox and its own branch. The agent works there. When it wants to keep something, it opens a change request.',
        'The change request merges. And this is the part that makes it a loop: the next fire starts from the new main. If the agent improved its own prompt or a skill, and that merged, the next run uses it.',
      ],
      node: (step) => (
        <Chapter n={0} title="A loop has four parts. The last one feeds the first.">
          <LoopDiagram step={step} content={LOOP} />
        </Chapter>
      ),
    },

    /* ── 02 · the file ───────────────────────────────────────────────────── */
    {
      id: 'file',
      label: 'The file',
      steps: 2,
      notes: [
        'Two. The file. An agent is a block in kortix.yaml. Its prompt is a markdown file in the repository. project.gitops.push lets it push and open change requests, and project_repository gives every session a checkout on its own branch.',
        'The trigger is six lines. Every one hour, run the builder, with this prompt. A cron works too. It has six fields, seconds first, so the first zero is seconds.',
        'Then two commands. kortix validate checks the file against the schema. kortix ship validates it, commits it and pushes it. Once it is on main, the trigger runs by itself.',
      ],
      node: (step) => (
        <Chapter
          n={1}
          title={
            <>
              The whole loop is a few lines of <Mono>kortix.yaml</Mono>.
            </>
          }
        >
          <div className="grid gap-6 lg:grid-cols-5">
            <div className="flex flex-col gap-4 lg:col-span-3">
              <Yaml lines={AGENT_YAML} />
              <Reveal on={step >= 1}>
                <Yaml lines={TRIGGER_YAML} />
              </Reveal>
            </div>
            <div className="flex flex-col gap-4 lg:col-span-2">
              <Panel className="p-5">
                <p className="text-foreground font-mono text-xs">agents.builder</p>
                <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
                  Who works. The prompt is <Mono>agents/builder.md</Mono>.{' '}
                  <Mono>project.gitops.push</Mono> lets it open a change request.
                </p>
              </Panel>
              <Reveal on={step >= 1}>
                <Panel className="p-5">
                  <p className="text-foreground font-mono text-xs">triggers</p>
                  <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
                    When. <Mono>every: 1h</Mono> starts a fresh session each hour. A cron has 6
                    fields, seconds first.
                  </p>
                </Panel>
              </Reveal>
              <Reveal on={step >= 2}>
                <Terminal
                  lines={[
                    { kind: 'cmd', text: 'kortix validate' },
                    { kind: 'out', text: '✓  kortix.yaml is valid' },
                    { kind: 'cmd', text: 'kortix ship' },
                  ]}
                />
              </Reveal>
            </div>
          </div>
        </Chapter>
      ),
    },

    /* ── 03 · three loops ────────────────────────────────────────────────── */
    {
      id: 'loops',
      label: 'Three loops',
      steps: 2,
      notes: [
        'Three. Three loops you can build this weekend. First, a software factory. Two agents, two triggers. Every hour the builder takes the oldest task in the backlog folder, writes the code and a test, and opens a change request. Every fifteen minutes a reviewer reads the open ones and merges them or sends them back.',
        'Second, GEO and SEO. Every morning at seven, a writer agent runs web search on the questions your buyers ask and notes who gets cited. Then it writes the page for one question your site does not answer yet. That page lands as a change request a person approves.',
        'Third, an X bot. Weekdays at nine, one and five, it reads mentions through the X connector from the catalog, then replies or posts. session reuse keeps one session across fires, so it remembers what it already said. Each post waits for approval. More on that in a second.',
      ],
      node: (step) => (
        <Chapter n={2} title="Three loops you can build this weekend.">
          <div className="grid gap-4 lg:grid-cols-3">
            {LOOPS.map((loop, i) => (
              <Reveal key={loop.title} on={step >= i} className="h-full">
                <Panel className="flex h-full flex-col p-5">
                  <span className="text-muted-foreground font-mono text-xs tabular-nums">
                    {`0${i + 1}`}
                  </span>
                  <h3 className="text-foreground mt-3 text-lg font-medium tracking-tight">
                    {loop.title}
                  </h3>
                  <YamlLines
                    lines={loop.yaml}
                    className="border-border bg-background mt-4 rounded-sm border p-3 text-xs"
                  />
                  <p className="text-muted-foreground mt-4 text-sm leading-relaxed">{loop.does}</p>
                  <div className="border-border mt-auto border-t pt-4">
                    <Verdict tone={loop.tone}>{loop.gate}</Verdict>
                  </div>
                </Panel>
              </Reveal>
            ))}
          </div>
        </Chapter>
      ),
    },

    /* ── 04 · the gate ───────────────────────────────────────────────────── */
    {
      id: 'gate',
      label: 'The gate',
      steps: 2,
      notes: [
        'Four. The gate. You decide where a person sits in the loop. The first place is each call. Set the policy default mode to risk: reads run, and every write or delete waits for approval. One catch: a session that a trigger started waits at most thirty minutes for a person, then stops. So approve while you watch it, and switch the mode back once you trust the posts.',
        'The second place is each change request. An agent without the merge grant cannot merge. Merge is default-deny for agents. The builder here can open change requests, and that is all.',
        'The third place is an agent you granted. An admin gives the reviewer project.gitops.merge, and it merges what the builder opened. A session still cannot merge its own change request without that grant. And a merge that edits agents or triggers needs its own permission, so the factory cannot widen its own reach.',
      ],
      node: (step) => (
        <Chapter n={3} title="You choose where a person approves.">
          <div className="border-border bg-card overflow-hidden rounded-sm border">
            {GATES.map((gate, i) => (
              <Reveal key={gate.where} on={step >= i}>
                <div
                  className={cn(
                    'border-border grid gap-4 px-6 py-5 lg:grid-cols-12 lg:items-center lg:gap-8',
                    i > 0 && 'border-t',
                  )}
                >
                  <div className="lg:col-span-3">
                    <Verdict tone={gate.tone}>
                      <span className="font-medium">{gate.where}</span>
                    </Verdict>
                  </div>
                  <YamlLines lines={gate.yaml} className="text-sm lg:col-span-5" />
                  <p className="text-muted-foreground text-sm leading-relaxed lg:col-span-4">
                    {gate.body}
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
        'So: start with one loop. Install the CLI, log in, kortix init, kortix ship.\n\nFor this hackathon, redeem the code FRONTIER at kortix.com slash redeem. The credits pay for your sandboxes. On the free plan, connect your own model key or your ChatGPT subscription for the model itself.\n\nAnd inside a session, kortix loop prompts that same session again on a schedule. It never starts a new one. Use it for things like: is CI green yet.\n\nEverything I showed you is open source. Read it, fork it, audit it.\n\nKortix. Your CompanyOS.',
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
                  { kind: 'cmd', text: 'kortix init my-loops' },
                  { kind: 'cmd', text: 'cd my-loops && kortix ship' },
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
              <p className="text-foreground text-base leading-relaxed">
                Hackathon credits: <Mono>kortix.com/redeem?code=FRONTIER</Mono>. They pay for
                compute.
              </p>
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
