'use client';

import { MANY_AGENTS, NOT_PLATFORM, SANDBOX } from '@/features/marketing/v2/content';
import { Icon } from '@/features/icon/icon';
import { Heading, LedeBullet, Section, TintPanel } from '@/features/marketing/v2/primitives';
import { cn } from '@/lib/utils';
import { ChevronsUpDown, GitBranch, Search } from 'lucide-react';
import type { ReactNode } from 'react';

/** Copy on one side, a product still on the other. */
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
    <Section id={id}>
      <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
        <div className={cn(reversed && 'lg:order-2')}>
          <Heading lines={heading} />
          <p className="text-muted-foreground mt-6 text-[1.0625rem] leading-relaxed">
            {description}
          </p>
          <div className="mt-10">
            {bullets.map((b) => (
              <LedeBullet key={b.lede} lede={b.lede} rest={b.rest} />
            ))}
          </div>
        </div>
        <TintPanel className={cn('aspect-[4/3]', reversed && 'lg:order-1')}>{visual}</TintPanel>
      </div>
    </Section>
  );
}

/* ── agents shouldn't become your platform ───────────────────────────────── */

export function NotPlatformSection() {
  return (
    <Split
      id="automations"
      heading={NOT_PLATFORM.heading}
      description={NOT_PLATFORM.description}
      bullets={NOT_PLATFORM.bullets}
      visual={<HarnessPicker />}
    />
  );
}

const HARNESS_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  'Claude Code': Icon.Claude,
  Codex: Icon.Codex,
  OpenCode: Icon.OpenCode,
  Gemini: Icon.Gemini,
  Cursor: Icon.Cursor,
};

function HarnessPicker() {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6 sm:p-8">
      <div className="relative w-full max-w-[19rem]">
        <div className="border-border bg-background mx-auto flex w-fit items-center gap-2 rounded-full border px-3.5 py-1.5 text-[13px] shadow-[0_1px_2px_rgba(26,31,46,0.05)]">
          <Icon.Claude className="size-3.5" />
          <span className="text-foreground font-medium">Multiple agents</span>
          <ChevronsUpDown className="text-muted-foreground size-3" />
        </div>

        <div className="border-border bg-background mt-3 overflow-hidden rounded-xl border shadow-[0_1px_2px_rgba(26,31,46,0.04),0_8px_10px_-1px_rgba(26,31,46,0.04)]">
          <div className="text-muted-foreground flex items-center gap-2 border-b border-black/[0.05] px-3 py-2 text-xs dark:border-white/[0.06]">
            <Search className="size-3" />
            Filter agents…
          </div>
          <ul className="p-1">
            {NOT_PLATFORM.harnesses.map((name, i) => {
              const Glyph = HARNESS_ICONS[name];
              return (
                <li
                  key={name}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-xs',
                    i === 3 ? 'bg-accent text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {Glyph ? <Glyph className="size-3" /> : <span className="size-3" />}
                  {name}
                </li>
              );
            })}
          </ul>
        </div>

        <div className="border-border bg-background/95 absolute -right-10 bottom-4 hidden w-36 overflow-hidden rounded-xl border p-1 shadow-[0_1px_2px_rgba(26,31,46,0.05)] backdrop-blur-sm sm:block">
          <p className="text-muted-foreground px-2 py-1.5 text-xs">Filter models…</p>
          {NOT_PLATFORM.models.map((model) => (
            <p key={model} className="text-muted-foreground/70 px-2 py-1 text-xs">
              {model}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── cloud dev environments ──────────────────────────────────────────────── */

export function SandboxSection() {
  return (
    <Split
      id="sandboxes"
      reversed
      heading={SANDBOX.heading}
      description={SANDBOX.description}
      bullets={SANDBOX.bullets}
      visual={<SessionsList />}
    />
  );
}

function SessionsList() {
  return (
    <div className="absolute inset-0 flex items-center p-6 sm:p-8">
      <div className="border-border bg-background w-full overflow-hidden rounded-xl border shadow-[0_1px_2px_rgba(26,31,46,0.04),0_8px_10px_-1px_rgba(26,31,46,0.04)]">
        <p className="text-muted-foreground border-b border-black/[0.05] px-4 py-3 text-[13px] dark:border-white/[0.06]">
          Sessions
        </p>
        <ul>
          {SANDBOX.sessions.map((session, i) => (
            <li
              key={session.title}
              className={cn('px-4 py-3', i === 0 && 'bg-accent/50')}
              style={{ opacity: 1 - i * 0.17 }}
            >
              <p className="text-foreground truncate text-[13px]">{session.title}</p>
              <p className="text-muted-foreground mt-1 flex items-center gap-2 text-[11px]">
                {session.who}
                {session.running && (
                  <span className="text-kortix-blue flex items-center gap-1 font-medium">
                    <span className="bg-kortix-blue size-1.5 rounded-full" />
                    Running…
                  </span>
                )}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ── the future isn't one agent ──────────────────────────────────────────── */

export function ManyAgentsSection() {
  return (
    <Split
      id="many-agents"
      heading={MANY_AGENTS.heading}
      description={MANY_AGENTS.description}
      bullets={MANY_AGENTS.bullets}
      visual={<ParallelRuns />}
    />
  );
}

const RUNS = [
  { title: 'Remove exposed API keys from audit log messages', harness: 'Claude Code' },
  { title: 'Backfill the missing firmographics for Q3', harness: 'Codex' },
  { title: 'Migrate session tokens to the new scheduler', harness: 'OpenCode' },
];

function ParallelRuns() {
  return (
    <div className="absolute inset-0 flex flex-col justify-center gap-3 p-6 sm:p-8">
      {RUNS.map((run, i) => {
        const Glyph = HARNESS_ICONS[run.harness];
        return (
          <div
            key={run.title}
            className="border-border bg-background rounded-xl border p-4 shadow-[0_1px_2px_rgba(26,31,46,0.05)]"
            style={{ marginLeft: `${i * 1.25}rem`, opacity: 1 - i * 0.22 }}
          >
            <p className="text-foreground truncate text-[13px] font-medium">{run.title}</p>
            <div className="mt-3 flex items-center gap-2">
              <span className="border-border bg-card flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]">
                {Glyph ? <Glyph className="size-3" /> : null}
                {run.harness}
              </span>
              <GitBranch className="text-kortix-green size-3.5" />
            </div>
          </div>
        );
      })}
    </div>
  );
}
