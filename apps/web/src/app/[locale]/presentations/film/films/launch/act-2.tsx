'use client';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  ArrowUpIcon,
  CheckIcon,
  FileTextIcon,
  FolderSimpleIcon,
  GitBranchIcon,
  GitMergeIcon,
} from '@phosphor-icons/react';
import { memo } from 'react';
import { useFrame } from '../../engine/film';
import { ease, fall, interp, rise, stagger, typed } from '../../engine/time';
import { Cursor, Headline, pressed, Window } from './parts';

/* ── Beat 3 · the repo ──────────────────────────────────────────────────── */

/** Real layout: `packages/starter/templates/base` + the site's source-of-truth map. */
const TREE: { depth: number; name: string; dir?: boolean; note?: string }[] = [
  { depth: 0, name: 'northwind', dir: true },
  { depth: 1, name: 'kortix.yaml', note: 'rules, triggers, connectors' },
  { depth: 1, name: '.kortix', dir: true },
  { depth: 2, name: 'opencode', dir: true },
  { depth: 3, name: 'agents', dir: true, note: 'who does the work' },
  { depth: 4, name: 'invoice-clerk.md' },
  { depth: 3, name: 'skills', dir: true, note: 'how the company works' },
  { depth: 4, name: 'reconcile-invoices' },
  { depth: 2, name: 'memory', dir: true, note: 'what it has learned so far' },
];

/** Every field is real — `company-as-code/content.ts` and the v2 schema. */
const YAML = [
  ['kortix_version: ', '2'],
  ['project:', ''],
  ['  name: ', 'Northwind'],
  ['', ''],
  ['agents:', ''],
  ['  invoice-clerk:', ''],
  ['    connectors: ', '[gmail-read]'],
  ['    secrets: ', '[STRIPE_API_KEY]'],
  ['    skills: ', '[reconcile-invoices]'],
  ['', ''],
  ['triggers:', ''],
  ['  - slug: ', 'month-end'],
  ['    type: ', 'cron'],
  ['    cron: ', '"0 0 7 1 * *"'],
  ['    agent: ', 'invoice-clerk'],
] as const;

export function Repo() {
  const f = useFrame();
  const tilt = interp(f, 0, 360, -16, -6, ease.inOutCubic);

  return (
    <div className="absolute inset-0 flex items-center gap-12 px-20">
      <div className="w-96 shrink-0 space-y-5">
        <Headline lead="Your company is" rest="a git repository." f={f} at={-4} size="text-5xl" />
        <p className="text-muted-foreground text-lg leading-relaxed" style={rise(f, 40)}>
          Agents, skills, memory, connectors and triggers — text in one repo. Versioned. Diffable. Owned
          outright.
        </p>
      </div>

      <div className="relative h-full flex-1" style={{ perspective: 1600 }}>
        <div
          className="absolute inset-0"
          style={{ transformStyle: 'preserve-3d', transform: `rotateY(${tilt}deg) rotateX(4deg)` }}
        >
          <Window
            title="northwind"
            aside={
              <span className="text-muted-foreground flex items-center gap-1 font-mono text-xs">
                <GitBranchIcon className="size-3.5" /> main
              </span>
            }
            className="absolute top-28 left-0 w-md"
            style={rise(f, 18, { dist: 40, scale: 0.96 })}
          >
            <ul className="space-y-1.5 px-4 py-4 font-mono text-sm">
              {TREE.map((row, i) => (
                <li
                  key={row.name}
                  className="flex items-center gap-2"
                  style={{ paddingLeft: row.depth * 18, ...rise(f, 34 + stagger(i, 7), { dist: 8 }) }}
                >
                  {row.dir ? (
                    <FolderSimpleIcon weight="fill" className="text-muted-foreground size-4 shrink-0" />
                  ) : (
                    <FileTextIcon className="text-muted-foreground size-4 shrink-0" />
                  )}
                  <span className="text-foreground">{row.name}</span>
                  {row.note ? (
                    <span
                      className="text-muted-foreground ml-auto font-sans text-xs"
                      style={{ opacity: interp(f, 146, 160, 1, 0, ease.outQuad) }}
                    >
                      {row.note}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </Window>

          <Window
            title="kortix.yaml"
            className="absolute top-52 right-0 w-sm"
            style={{ ...rise(f, 150, { dist: 60, scale: 0.94 }), transform: `${rise(f, 150, { dist: 60, scale: 0.94 }).transform} translateZ(60px)` }}
          >
            <pre className="px-4 py-4 font-mono text-xs leading-relaxed">
              {YAML.map(([k, v], i) => (
                <div key={i} style={{ opacity: interp(f, 162 + i * 3, 170 + i * 3, 0, 1, ease.outQuad) }}>
                  <span className="text-muted-foreground">{k}</span>
                  <span className="text-foreground">{v}</span>
                  {' '}
                </div>
              ))}
            </pre>
          </Window>
        </div>
      </div>
    </div>
  );
}

/* ── Beat 4 · a session boots its own computer ──────────────────────────── */

const PROMPT = 'Fix the billing webhook retry and prove it with a test';

const STEPS = [
  { at: 118, busy: 'Booting a cloud computer', done: 'Cloud computer ready' },
  { at: 148, busy: 'Cloning northwind into /workspace', done: 'Cloned northwind into /workspace' },
  { at: 178, busy: 'Cutting a branch', done: 'On branch session/billing-retry' },
  { at: 208, busy: '$ pnpm test billing', done: '$ pnpm test billing   14 passed' },
];

export function Session() {
  const f = useFrame();
  const text = typed(PROMPT, f, 22, 1.1);
  const composer = f < 96 ? rise(f, 0, { dist: 30 }) : fall(f, 96, { dist: -20, blur: 6 });

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center px-20">
      <div className="text-center">
        <Headline lead="Every session gets" rest="its own computer." f={f} at={-6} size="text-5xl" />
      </div>

      <div className="relative mt-10 h-80 w-3xl">
        {f < 112 ? (
          <div
            className="border-border bg-popover absolute inset-x-0 top-16 flex items-end gap-3 rounded-2xl border px-5 py-4 shadow-2xl"
            style={composer}
          >
            <p className="text-foreground min-h-12 flex-1 text-lg">
              {text}
              <span
                className="bg-foreground ml-0.5 inline-block h-5 w-px align-middle"
                style={{ opacity: Math.floor(f / 15) % 2 && text.length === PROMPT.length ? 0 : 1 }}
              />
            </p>
            <span
              className="bg-foreground text-background grid size-9 shrink-0 place-items-center rounded-full"
              style={{ transform: `scale(${pressed(f, 86)})` }}
            >
              <ArrowUpIcon weight="bold" className="size-4" />
            </span>
          </div>
        ) : null}

        {f >= 96 ? (
          <Window
            title="session · billing-retry"
            aside={
              <span className="text-muted-foreground flex items-center gap-1 font-mono text-xs">
                <GitBranchIcon className="size-3.5" /> session/billing-retry
              </span>
            }
            className="absolute inset-x-0 top-0"
            style={rise(f, 100, { dist: 40, scale: 0.96 })}
          >
            <div className="space-y-5 px-5 py-5">
              <div className="flex justify-end">
                <p className="bg-muted text-foreground rounded-md px-3 py-2 text-sm">{PROMPT}</p>
              </div>
              <ul className="space-y-3 font-mono text-sm">
                {STEPS.map((s) => {
                  const done = f >= s.at + 22;
                  return (
                    <li key={s.at} className="flex items-center gap-3" style={rise(f, s.at, { dist: 10 })}>
                      <span
                        className={cn(
                          'grid size-5 shrink-0 place-items-center rounded-full border',
                          done ? 'border-foreground bg-foreground text-background' : 'border-border',
                        )}
                      >
                        {done ? (
                          <CheckIcon weight="bold" className="size-3" />
                        ) : (
                          <span
                            className="bg-muted-foreground size-1.5 rounded-full"
                            style={{ opacity: 0.4 + 0.6 * Math.abs(Math.sin(((f - s.at) / 20) * Math.PI)) }}
                          />
                        )}
                      </span>
                      <span className={done ? 'text-foreground' : 'text-muted-foreground'}>
                        {done ? s.done : s.busy}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </Window>
        ) : null}
      </div>
    </div>
  );
}

/* ── Beat 5 · thousands, in parallel ────────────────────────────────────── */

const TASKS = [
  'billing-retry', 'weekly-report', 'lead-research', 'invoice-sync', 'support-triage',
  'churn-analysis', 'pricing-page', 'onboarding-email', 'contract-review', 'qa-sweep',
  'release-notes', 'renewal-brief', 'bug-bash', 'data-cleanup', 'competitor-scan',
  'hiring-loop', 'seo-audit', 'close-books', 'deck-refresh', 'status-update',
];
const COLS = 31;
const ROWS = 29;
const CARD_W = 236;
const CARD_H = 112;
const GAP = 16;

/** The centre card is the session from the previous beat; the field grows around it. */
const CENTER = Math.floor((COLS * ROWS) / 2);

const SessionCard = memo(function SessionCard({ i, opacity }: { i: number; opacity: number }) {
  const task = TASKS[((((i - CENTER) * 7) % TASKS.length) + TASKS.length) % TASKS.length];
  return (
    <div
      className="border-border bg-popover flex flex-col justify-between rounded-md border px-3 py-3"
      style={{ width: CARD_W, height: CARD_H, opacity }}
    >
      <div className="flex items-center gap-2">
        <span className="bg-foreground size-1.5 rounded-full" />
        <span className="text-foreground truncate font-mono text-xs">session/{task}</span>
      </div>
      <div className="space-y-1.5">
        <div className="bg-muted h-1.5 w-4/5 rounded-full" />
        <div className="bg-muted h-1.5 w-1/2 rounded-full" />
      </div>
    </div>
  );
});

export function Workforce() {
  const f = useFrame();
  const zoom = interp(f, 36, 250, 1.6, 0.21, ease.inOutCubic);
  const dim = interp(f, 190, 230, 1, 0.3, ease.outQuad);
  const cx = (COLS - 1) / 2;
  const cy = (ROWS - 1) / 2;

  return (
    <div className="absolute inset-0 overflow-hidden">
      <div
        className="absolute top-1/2 left-1/2 grid"
        style={{
          gridTemplateColumns: `repeat(${COLS}, ${CARD_W}px)`,
          gap: GAP,
          opacity: dim,
          transform: `translate(-50%, -50%) scale(${zoom})`,
        }}
      >
        {Array.from({ length: COLS * ROWS }, (_, i) => {
          const ring = Math.max(Math.abs((i % COLS) - cx), Math.abs(Math.floor(i / COLS) - cy));
          const at = ring === 0 ? -20 : 40 + ring ** 0.8 * 13;
          const o = Math.round(interp(f, at, at + 14, 0, 1, ease.outQuad) * 20) / 20;
          return <SessionCard key={i} i={i} opacity={o} />;
        })}
      </div>

      <div className="absolute inset-0 grid place-items-center">
        <div className="max-w-3xl text-center">
          <Headline lead="Thousands of sessions." rest="One config." f={f} at={200} />
          <p className="text-muted-foreground mt-5 text-xl" style={rise(f, 232)}>
            Each on its own computer, on its own branch.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ── Beat 6 · work lands through a change request ───────────────────────── */

const DIFF: { sign: ' ' | '+' | '-'; text: string; file?: boolean }[] = [
  { sign: ' ', text: 'src/billing/webhook.ts', file: true },
  { sign: '-', text: 'await deliver(event)' },
  { sign: '+', text: 'await retry(() => deliver(event), {' },
  { sign: '+', text: "  attempts: 5, backoff: 'exponential'," },
  { sign: '+', text: '})' },
  { sign: ' ', text: 'test/billing/webhook.test.ts', file: true },
  { sign: '+', text: "it('retries a failed delivery', async () => {" },
];

const PRESS = 222;

export function ChangeRequest() {
  const f = useFrame();
  const merged = f >= PRESS + 8;
  const swap = merged ? interp(f, PRESS + 8, PRESS + 22, 6, 0) : 0;

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center px-20">
      <div className="text-center">
        <Headline lead="Work lands through a change request" rest="you approve." f={f} at={-6} size="text-5xl" />
      </div>

      <Window
        title="change request"
        aside={
          <span className="text-muted-foreground font-mono text-xs">
            session/billing-retry → main
          </span>
        }
        className="mt-10 w-3xl"
        style={rise(f, 30, { dist: 40, scale: 0.96 })}
      >
        <div className="space-y-2 px-5 pt-5 pb-4">
          <div className="flex items-center gap-3">
            <span style={{ filter: `blur(${swap}px)` }}>
              {merged ? (
                <Badge variant="success" size="sm">
                  <GitMergeIcon weight="bold" /> Merged
                </Badge>
              ) : (
                <Badge variant="outline" size="sm">
                  <GitBranchIcon weight="bold" /> Open
                </Badge>
              )}
            </span>
            <span className="text-foreground text-lg font-medium">Retry billing webhooks with backoff</span>
          </div>
          <p className="text-muted-foreground text-xs">
            Opened by the engineer agent · 2 files · +5 −1 · tests pass
          </p>
        </div>

        <div className="bg-card border-border border-y px-5 py-3 font-mono text-xs leading-relaxed">
          {DIFF.map((d, i) => (
            <div
              key={i}
              className={cn(
                'flex gap-3',
                d.file ? 'text-muted-foreground pt-1' : d.sign === '-' ? 'text-muted-foreground line-through' : 'text-foreground',
              )}
              style={{ opacity: interp(f, 60 + stagger(i, 5), 72 + stagger(i, 5), 0, 1, ease.outQuad) }}
            >
              <span className="w-3">{d.file ? '' : d.sign}</span>
              <span>{d.text}</span>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4">
          <span className="border-border text-muted-foreground rounded-md border px-3 py-1.5 text-sm">
            Request changes
          </span>
          <span
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium',
              merged ? 'bg-kortix-green/15 text-kortix-green' : 'bg-foreground text-background',
            )}
            style={{ transform: `scale(${pressed(f, PRESS)})` }}
          >
            {merged ? 'Merged into main' : 'Approve & merge'}
          </span>
        </div>
      </Window>

      <Cursor f={f} from={[1180, 780]} to={[934, 558]} at={150} arrive={206} press={PRESS} />
    </div>
  );
}
