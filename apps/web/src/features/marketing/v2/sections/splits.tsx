'use client';

import { Icon } from '@/features/icon/icon';
import { AS_CODE, SANDBOX, WORKFORCE } from '@/features/marketing/v2/content';
import { Display, LedeBullet, Lead, MAX_W } from '@/features/marketing/v2/primitives';
import { cn } from '@/lib/utils';
import { ChevronsUpDown, File, Folder, GitBranch, GitMerge, Search } from 'lucide-react';
import type { ReactNode } from 'react';

/** Copy on one side, a big gradient panel on the other. Tembo's split rhythm. */
function Split({
  id,
  heading,
  description,
  bullets,
  visual,
  reversed,
}: {
  id: string;
  heading: string[];
  description: string;
  bullets: { lede: string; rest: string }[];
  visual: ReactNode;
  reversed?: boolean;
}) {
  return (
    <section id={id} className="scroll-mt-24 py-20 sm:py-28">
      <div className={MAX_W}>
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <div className={cn(reversed && 'lg:order-2')}>
            <Display lines={heading} />
            <Lead className="mt-7">{description}</Lead>
            <div className="mt-10">
              {bullets.map((b) => (
                <LedeBullet key={b.lede} lede={b.lede} rest={b.rest} />
              ))}
            </div>
          </div>

          <div
            className={cn(
              'relative flex aspect-[4/3] items-center justify-center overflow-hidden rounded-[1.5rem] p-8',
              reversed && 'lg:order-1',
            )}
            style={{
              background:
                'linear-gradient(155deg, color-mix(in oklab, var(--kortix-blue) 5%, var(--background)) 0%, color-mix(in oklab, var(--kortix-blue) 22%, var(--background)) 100%)',
              border: '1px solid color-mix(in oklab, var(--kortix-blue) 12%, transparent)',
            }}
          >
            {visual}
          </div>
        </div>
      </div>
    </section>
  );
}

function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'bg-background w-full overflow-hidden rounded-[0.9rem] shadow-[0_18px_50px_-12px_rgba(26,31,46,0.22)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ── your company as code ────────────────────────────────────────────────── */

export function AsCodeSection() {
  return (
    <Split
      id="company-as-code"
      heading={AS_CODE.heading}
      description={AS_CODE.description}
      bullets={AS_CODE.bullets}
      visual={<RepoExplorer />}
    />
  );
}

function RepoExplorer() {
  return (
    <Card className="max-w-xl">
      <div className="grid sm:grid-cols-[11.5rem_1fr]">
        <div className="border-border border-b p-3 sm:border-r sm:border-b-0">
          <p className="text-muted-foreground mb-2 px-1.5 font-mono text-[11px]">acme-ops</p>
          {AS_CODE.tree.map((node) => (
            <div
              key={node.name}
              className={cn(
                'flex items-center gap-1.5 rounded px-1.5 py-[3px] font-mono text-[11.5px]',
                node.accent ? 'bg-accent text-foreground' : 'text-muted-foreground',
              )}
              style={{ paddingLeft: `${0.375 + (node.depth ?? 0) * 0.85}rem` }}
            >
              {node.kind === 'dir' ? (
                <Folder className="text-kortix-blue size-3 shrink-0" />
              ) : (
                <File className="size-3 shrink-0" />
              )}
              {node.name}
            </div>
          ))}
        </div>

        <div className="min-w-0">
          <div className="border-border text-muted-foreground flex items-center gap-2 border-b px-4 py-2.5 font-mono text-[11px]">
            {AS_CODE.file.name}
            <span className="bg-kortix-green/15 text-kortix-green ml-auto rounded px-1.5 py-0.5 text-[10px]">
              on main
            </span>
          </div>
          <pre className="overflow-x-auto p-4 font-mono text-[11.5px] leading-[1.7]">
            {AS_CODE.file.lines.map((line, i) => (
              <div key={`${i}:${line}`} className="whitespace-pre">
                <span className="text-muted-foreground/35 mr-3.5 inline-block w-3 text-right select-none">
                  {i + 1}
                </span>
                <span
                  className={
                    line.trimStart().startsWith('-')
                      ? 'text-kortix-blue'
                      : line.endsWith(':')
                        ? 'text-foreground font-medium'
                        : 'text-muted-foreground'
                  }
                >
                  {line || ' '}
                </span>
              </div>
            ))}
          </pre>
        </div>
      </div>
    </Card>
  );
}

/* ── sandboxes ───────────────────────────────────────────────────────────── */

export function SandboxSection() {
  return (
    <Split
      id="sandboxes"
      reversed
      heading={SANDBOX.heading}
      description={SANDBOX.description}
      bullets={SANDBOX.bullets}
      visual={<SessionsCard />}
    />
  );
}

const SESSION_ROWS = [
  { title: 'Draft the renewal for Acme', who: 'Marko and 2 more people', running: true },
  { title: 'Triage 42 new support threads', who: 'support-triage' },
  { title: 'Reconcile the Stripe payouts for July', who: 'finance-ops' },
  { title: 'Refresh the pricing review deck', who: 'Darren' },
  { title: 'Weekly revenue digest for #company-ops', who: 'Trigger · 08:00' },
];

function SessionsCard() {
  return (
    <Card className="max-w-md">
      <p className="border-border text-muted-foreground border-b px-4 py-3 text-[13px]">Sessions</p>
      <ul>
        {SESSION_ROWS.map((row, i) => (
          <li
            key={row.title}
            className={cn('px-4 py-3.5', i === 0 && 'bg-accent')}
            style={{ opacity: 1 - i * 0.16 }}
          >
            <p className="text-foreground truncate text-[13.5px]">{row.title}</p>
            <p className="text-muted-foreground mt-1 flex items-center gap-2 text-[11.5px]">
              {row.who}
              {row.running && (
                <span className="text-kortix-blue flex items-center gap-1 font-medium">
                  <span className="bg-kortix-blue size-1.5 rounded-full" />
                  Running…
                </span>
              )}
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ── a workforce, not an assistant ───────────────────────────────────────── */

export function WorkforceSection() {
  return (
    <Split
      id="workforce"
      heading={WORKFORCE.heading}
      description={WORKFORCE.description}
      bullets={WORKFORCE.bullets}
      visual={<ParallelRuns />}
    />
  );
}

const RUNS = [
  { title: 'Draft the renewal for Acme', agent: 'go-to-market', icon: Icon.Claude },
  { title: 'Triage 42 new support threads', agent: 'support-triage', icon: Icon.Codex },
  { title: 'Reconcile the Stripe payouts', agent: 'finance-ops', icon: Icon.OpenCode },
];

function ParallelRuns() {
  return (
    <div className="flex w-full max-w-md flex-col gap-3">
      {RUNS.map((run, i) => {
        const Glyph = run.icon;
        return (
          <Card key={run.title} className="p-4" >
            <p className="text-foreground truncate text-[13.5px] font-medium">{run.title}</p>
            <div className="mt-3 flex items-center gap-2">
              <span className="border-border text-muted-foreground flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]">
                <Glyph className="size-3" />
                {run.agent}
              </span>
              <GitBranch className="text-kortix-green size-3.5" />
            </div>
          </Card>
        );
      })}
      <p className="text-muted-foreground mt-1 flex items-center gap-2 pl-1 font-mono text-[11.5px]">
        <GitMerge className="text-kortix-green size-3.5" />
        main · always running, always improving
      </p>
    </div>
  );
}

/* ── agents shouldn't become your platform ───────────────────────────────── */

const HARNESSES = [
  { name: 'Claude Code', icon: Icon.Claude },
  { name: 'Codex', icon: Icon.Codex },
  { name: 'OpenCode', icon: Icon.OpenCode },
  { name: 'Gemini', icon: Icon.Gemini },
  { name: 'Cursor', icon: Icon.Cursor },
];
const MODELS = ['Opus 5', 'Sonnet 5', 'GPT-5.5', 'Gemini 3 Pro', 'Grok 4'];

export function NotPlatformSection() {
  return (
    <Split
      id="agnostic"
      heading={["Agents shouldn't", 'become your platform']}
      description="Models, harnesses, and vendors will change. Your workflows shouldn't. Use Claude Code, Codex, OpenCode, or whatever comes next — Kortix gives your team a stable system while the agent layer moves underneath it."
      bullets={[
        {
          lede: 'Use agents by mention.',
          rest: 'Call an agent straight from Slack, Teams, Linear, or GitHub with a plain @mention.',
        },
        {
          lede: 'Swap harnesses with a dropdown.',
          rest: 'No contract changes, no migrations. If a better model ships tomorrow, use it today.',
        },
        {
          lede: 'Your config comes with you.',
          rest: 'Agents, skills, and repo instructions are files. They work the same on our cloud or yours.',
        },
      ]}
      visual={<HarnessPicker />}
    />
  );
}

function HarnessPicker() {
  return (
    <div className="relative w-full max-w-[19rem]">
      <div className="bg-background mx-auto flex w-fit items-center gap-2 rounded-full px-4 py-2 text-[13px] shadow-[0_6px_18px_-6px_rgba(26,31,46,0.22)]">
        <Icon.Claude className="size-3.5" />
        <span className="text-foreground font-medium">Multiple agents</span>
        <ChevronsUpDown className="text-muted-foreground size-3" />
      </div>

      <Card className="mt-3">
        <div className="border-border text-muted-foreground flex items-center gap-2 border-b px-3.5 py-2.5 text-[12px]">
          <Search className="size-3.5" />
          Filter agents…
        </div>
        <ul className="p-1.5">
          {HARNESSES.map((h, i) => (
            <li
              key={h.name}
              className={cn(
                'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[12.5px]',
                i === 3 ? 'bg-accent text-foreground' : 'text-muted-foreground',
              )}
            >
              <h.icon className="size-3.5" />
              {h.name}
            </li>
          ))}
        </ul>
      </Card>

      <div className="bg-background/95 absolute -right-14 bottom-3 hidden w-36 rounded-[0.75rem] p-1.5 shadow-[0_14px_36px_-10px_rgba(26,31,46,0.28)] backdrop-blur-sm sm:block">
        <p className="text-muted-foreground px-2 py-1.5 text-[12px]">Filter models…</p>
        {MODELS.map((m) => (
          <p key={m} className="text-muted-foreground/70 px-2 py-1 text-[12px]">
            {m}
          </p>
        ))}
      </div>
    </div>
  );
}
