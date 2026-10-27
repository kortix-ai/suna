'use client';

import { Button } from '@kortix/ui/button';
import { CountBadge } from '@kortix/ui/count-badge';
import Hint from '@kortix/ui/hint';
import { ProgressRing } from '@kortix/ui/progress-ring';
import { CustomizeGlyph } from './customize-glyph';
import { SidebarToggle } from '@kortix/ui/workspace';
import { cn } from '@kortix/ui';
import {
  ArrowUpIcon,
  CaretDownIcon,
  CaretUpDownIcon,
  GaugeIcon,
  PaperclipIcon,
  FolderSimpleIcon,
  GlobeSimpleIcon,
  ShareIcon,
  TerminalIcon,
  DotsThreeIcon,
  DotsThreeOutlineIcon,
  MagnifyingGlassIcon,
  NavigationArrowIcon,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { SessionStatusMark } from './session-status-mark';

/**
 * The Kortix session screen, rebuilt as live DOM for the landing hero (Paper
 * "Kortix 2", HVL-0). It is drawn once at the board's size, 1264 × 860, and
 * scaled to the column, so it reads as the product at every width instead of
 * reflowing into something the product never shows.
 *
 * Every name and number is a synthetic "Northwind" fixture. It plays once when
 * it scrolls into view: the prompt is typed and sent, the turn works, then the
 * reply lands block by block and rests on the exact board state. Reduced
 * motion skips straight to that state.
 */

const W = 1264;
const H = 860;

const PROMPT =
  'Build a revenue dashboard for Northwind from the warehouse data for the last five months.';
const PROMPT_MORE =
  'Track revenue, new accounts, churn and renewals by month. Include charts, a top-accounts table and what changed this week.';

const TODAY = ['Monday revenue report', 'Triage support tickets', 'Review change request', 'Q4 board deck'];

// Mostly live work, in the sidebar's own glyphs (session-status-mark.tsx):
//   running      the agent is working: green arc with a fading trail
//   done         the agent is idle, ready for a prompt: green dot ring
//   needs-you    waiting on you: blue question (answer) or diff (review)
//   stopped      asleep: gray ring
type RowStatus = { status: 'running' | 'done' | 'stopped' } | { status: 'needs-you'; waitingOn: 'answer' | 'review' };
const STATUS: Record<string, RowStatus> = {
  'Monday revenue report': { status: 'running' },
  'Triage support tickets': { status: 'running' },
  'Review change request': { status: 'needs-you', waitingOn: 'review' },
  'Q4 board deck': { status: 'done' },
  'Renewal emails': { status: 'needs-you', waitingOn: 'answer' },
  'Onboard a new hire': { status: 'running' },
  'Weekly pipeline summary': { status: 'done' },
  'Clean up the vendor list': { status: 'stopped' },
  'Fix the onboarding docs': { status: 'running' },
};

function RowStatusMark({ row }: { row: RowStatus }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      <SessionStatusMark {...row} />
    </span>
  );
}
const THIS_WEEK = [
  'Renewal emails',
  'Onboard a new hire',
  'Weekly pipeline summary',
  'Clean up the vendor list',
  'Fix the onboarding docs',
];

const STATS = [
  { label: 'Revenue', value: '$4.82M' },
  { label: 'New accounts', value: '186' },
  { label: 'Churned', value: '12' },
  { label: 'Renewal rate', value: '92.4%' },
];

const WORK_STEPS = [
  'Read the finance schema',
  'Queried six monthly buckets',
  'Built the dashboard and checked the totals',
];

/** Seconds the turn "works" for, shown as 4m 12s. */
const WORKED_SECONDS = 252;

/** Script beats, in ms from the moment the window is in view. */
const BEAT = {
  typeStart: 500,
  charMs: 16,
  sendGap: 350,
  workMs: 1400,
  blockGap: 110,
} as const;

/** Reply blocks after the "Worked for" row, in reading order. */
const BLOCKS = 7;

type Stage = { typed: number; sent: boolean; worked: number; done: boolean; shown: number };

const FINAL: Stage = { typed: 0, sent: true, worked: WORKED_SECONDS, done: true, shown: BLOCKS };
const START: Stage = { typed: 0, sent: false, worked: 0, done: false, shown: 0 };

function formatWorked(s: number) {
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function useScript(target: React.RefObject<HTMLElement | null>) {
  const [stage, setStage] = useState<Stage>(START);

  useEffect(() => {
    const el = target.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setStage(FINAL);
      return;
    }

    const timers: number[] = [];
    let raf = 0;
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));

    const play = () => {
      for (let i = 1; i <= PROMPT.length; i++) {
        at(BEAT.typeStart + i * BEAT.charMs, () => setStage((s) => ({ ...s, typed: i })));
      }
      const sendAt = BEAT.typeStart + PROMPT.length * BEAT.charMs + BEAT.sendGap;
      at(sendAt, () => {
        setStage((s) => ({ ...s, typed: 0, sent: true }));
        // The counter is time passing, so it runs linear against the clock.
        const t0 = performance.now();
        const tick = (now: number) => {
          const p = Math.min(1, (now - t0) / BEAT.workMs);
          setStage((s) => ({ ...s, worked: Math.round(p * WORKED_SECONDS) }));
          if (p < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      });
      const doneAt = sendAt + BEAT.workMs + 120;
      at(doneAt, () => setStage((s) => ({ ...s, done: true })));
      for (let b = 1; b <= BLOCKS; b++) {
        at(doneAt + b * BEAT.blockGap, () => setStage((s) => ({ ...s, shown: b })));
      }
    };

    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        io.disconnect();
        play();
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      timers.forEach(clearTimeout);
      cancelAnimationFrame(raf);
    };
  }, [target]);

  return stage;
}

/** Fits the fixed-size board to its column. */
function useFitScale(frame: React.RefObject<HTMLElement | null>) {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setScale(entry.contentRect.width / W);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [frame]);
  return scale;
}

/** One reply block: in the DOM from the first frame, raised when its beat lands. */
function Reveal({ on, children, className }: { on: boolean; children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'duration-moderate ease-out transition-[opacity,translate] motion-reduce:transition-none',
        on ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0',
        className,
      )}
    >
      {children}
    </div>
  );
}

function Icon({ d, size = 16, children }: { d?: string; size?: number; children?: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      aria-hidden
      className="shrink-0"
    >
      {d ? <path d={d} /> : children}
    </svg>
  );
}

function SessionRow({
  label,
  count,
  active,
  onSelect,
}: {
  label: string;
  count?: number;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active || undefined}
      className={cn(
        'focus-visible:ring-kortix-base flex h-9 w-full shrink-0 items-center justify-between rounded-md px-2 text-left outline-none focus-visible:ring-1',
        active ? 'bg-active' : 'hover:bg-hover',
      )}
    >
      <span className="flex items-center gap-2.5">
        <RowStatusMark row={STATUS[label] ?? { status: 'stopped' }} />
        <span className="text-sm whitespace-nowrap">{label}</span>
      </span>
      {count ? <CountBadge count={count} /> : null}
    </button>
  );
}

function Sidebar() {
  const [active, setActive] = useState(TODAY[0]);
  return (
    <aside className="bg-sidebar border-sidebar-border flex w-68 shrink-0 flex-col border-r">
      <div className="flex h-15 shrink-0 items-center justify-between pr-4 pl-4">
        <div className="flex items-center gap-2">
          <span className="bg-foreground text-background flex size-6 items-center justify-center rounded-sm text-xs font-semibold">
            N
          </span>
          <span className="text-sm font-medium">Northwind</span>
          <CaretUpDownIcon className="text-muted-foreground size-3.5 shrink-0" />
        </div>
        <div className="flex gap-3">
          <MagnifyingGlassIcon className="size-4" />
          <SidebarToggle className="size-4" />
        </div>
      </div>

      <div className="flex flex-col gap-0.5 px-2 pt-1 pb-4">
        <div className="flex h-9 items-center gap-2.5 px-2">
          <NavigationArrowIcon className="size-4 shrink-0 rotate-90" />
          <span className="text-sm">New session</span>
        </div>
        <div className="flex h-9 items-center justify-between px-2">
          <span className="flex items-center gap-2.5">
            <CustomizeGlyph className="size-4 shrink-0" />
            <span className="text-sm">Customize</span>
          </span>
          <CountBadge count={4} />
        </div>
        <div className="flex h-9 items-center gap-2.5 px-2">
          <DotsThreeOutlineIcon weight="fill" className="size-4 shrink-0" />
          <span className="text-sm">More</span>
        </div>
      </div>

      <div className="text-muted-foreground flex h-8 items-center justify-between px-4 text-sm">
        <span>Sessions</span>
        <DotsThreeIcon aria-hidden className="size-4" />
      </div>
      <nav aria-label="Sessions" className="flex flex-col px-2">
        <p className="text-muted-foreground h-8 px-2 pt-1.5 text-sm">Today</p>
        {TODAY.map((label) => (
          <SessionRow
            key={label}
            label={label}
            count={label === 'Review change request' ? 1 : undefined}
            active={active === label}
            onSelect={() => setActive(label)}
          />
        ))}
        <p className="text-muted-foreground h-8 px-2 pt-2.5 text-sm">This week</p>
        {THIS_WEEK.map((label) => (
          <SessionRow key={label} label={label} active={active === label} onSelect={() => setActive(label)} />
        ))}
      </nav>

    </aside>
  );
}

/**
 * The composer, built from the same parts and classes as the app's
 * ComposerCard: the card (editor + toolbar with the model and effort pickers
 * and the round send button), then the underbar (attach, agent, context ring).
 */
function Composer({ typed }: { typed: number }) {
  const text = PROMPT.slice(0, typed);
  return (
    <div className="bg-background absolute bottom-0 left-1/2 flex w-152 -translate-x-1/2 flex-col pt-4">
      <div className="bg-background border-border relative w-full rounded-xl border pt-3">
        <div className="flex min-w-0 flex-col px-2 pb-2">
          <div className="relative min-w-0 cursor-text px-1 pb-9 text-sm">
            {text ? (
              <p className="text-foreground">
                {text}
                <span aria-hidden className="bg-foreground ml-px inline-block h-4 w-px align-middle" />
              </p>
            ) : (
              <p className="text-muted-foreground truncate">Type / for skills, commands, and files</p>
            )}
          </div>
          <div className="flex items-center justify-between gap-1">
            <div className="flex min-w-0 items-center gap-1">
              <Button type="button" variant="ghost" size="sm" className="text-muted-foreground rounded-lg">
                <span className="max-w-30 truncate">Sonnet 5.5</span>
                <CaretDownIcon className="size-3" />
              </Button>
              <Button type="button" variant="ghost" size="sm" className="text-muted-foreground gap-1.5 rounded-lg">
                <GaugeIcon className="size-4 shrink-0" />
                <span>Auto</span>
                <CaretDownIcon className="size-3 opacity-50" />
              </Button>
            </div>
            <Button
              type="button"
              size="icon-base"
              aria-label="Send message"
              disabled={!text}
              className="shrink-0 rounded-full p-0 transition-[color,background-color,opacity,scale] duration-slow ease-out active:scale-[0.96]"
            >
              <ArrowUpIcon className="size-4" />
            </Button>
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 px-px pt-1.5 pb-2">
        <div className="flex min-w-0 items-center gap-1">
          <Button type="button" variant="ghost" size="icon-base" aria-label="Attach files" className="text-muted-foreground rounded-lg">
            <PaperclipIcon className="size-4 shrink-0" />
          </Button>
          <Button type="button" variant="ghost" size="sm" className="text-muted-foreground rounded-lg">
            <span className="max-w-[100px] truncate">Kortix</span>
            <CaretDownIcon className="size-3" />
          </Button>
        </div>
        <span className="flex size-8 items-center justify-center" aria-hidden>
          <ProgressRing value={18} progressClassName="text-kortix-blue" className="size-4" />
        </span>
      </div>
    </div>
  );
}

function Thread({ stage }: { stage: Stage }) {
  const [open, setOpen] = useState(false);
  const shown = (n: number) => stage.shown >= n;

  return (
    <div className="mx-auto flex w-152 flex-col pt-2.5">
      <Reveal on={stage.sent} className="bg-secondary flex w-122 flex-col gap-2.5 self-end rounded-lg px-4 py-3">
        <p className="text-sm leading-relaxed">{PROMPT}</p>
        <p className="text-sm leading-relaxed">{PROMPT_MORE}</p>
        <p className="text-muted-foreground text-sm leading-relaxed">Show more</p>
      </Reveal>

      <div className="flex flex-col gap-4 pt-7">
        <Reveal on={stage.sent}>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            disabled={!stage.done}
            aria-expanded={open}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-kortix-base flex items-center gap-1.5 rounded-sm text-sm outline-none focus-visible:ring-1"
          >
            {stage.done ? `Worked for ${formatWorked(stage.worked)}` : `Working for ${formatWorked(stage.worked)}`}
            <span className={cn('duration-moderate transition-transform ease-out', open && 'rotate-90')}>
              <Icon size={10} d="M6 3l5 5-5 5" />
            </span>
          </button>
          {open ? (
            <ul className="text-muted-foreground mt-2 flex flex-col gap-1 border-l pl-3 text-sm">
              {WORK_STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          ) : null}
        </Reveal>

        <Reveal on={shown(1)}>
          <h3 className="text-xl font-semibold tracking-tight">Northwind revenue dashboard</h3>
        </Reveal>
        <Reveal on={shown(2)}>
          <p className="text-sm leading-relaxed">
            Verified warehouse data for May 1 to October 16, 2026, five months across six monthly buckets.
            Switch tabs below for revenue, accounts, churn and renewals; links open the underlying queries.
          </p>
        </Reveal>
        <Reveal on={shown(3)}>
          <p className="text-sm leading-relaxed">
            Coverage: revenue comes from the finance schema, including refunds. This is a fetched snapshot,
            not a live-connected dashboard.
          </p>
        </Reveal>
        <Reveal on={shown(4)} className="pt-2.5">
          <h4 className="text-lg font-semibold tracking-tight">1. Revenue overview</h4>
        </Reveal>
        <Reveal on={shown(5)}>
          <p className="text-sm leading-relaxed">
            Net revenue is up 4.1% week over week. May and October are partial months and should not be
            compared directly with full-month totals.
          </p>
        </Reveal>
        <Reveal on={shown(6)}>
          <dl className="border-border flex overflow-hidden rounded-lg border">
            {STATS.map((s, i) => (
              <div
                key={s.label}
                className={cn('flex flex-1 flex-col gap-1 px-4 py-3', i < STATS.length - 1 && 'border-border border-r')}
              >
                <dt className="text-muted-foreground text-xs">{s.label}</dt>
                <dd className="text-lg tabular-nums">{s.value}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
        <Reveal on={shown(7)} className="pt-2.5">
          <h4 className="text-lg font-semibold tracking-tight">2. Monthly performance</h4>
        </Reveal>
      </div>
    </div>
  );
}

const DEV_TOOLS = [
  { id: 'terminal', label: 'Terminal', Icon: TerminalIcon },
  { id: 'browser', label: 'Browser', Icon: GlobeSimpleIcon },
  { id: 'files', label: 'Files', Icon: FolderSimpleIcon },
] as const;

/**
 * The session header's tools, as in session-site-header.tsx: ghost icon
 * buttons with a tooltip, then Share. Here a click marks the tool open (the
 * window has no panel to show), so the controls answer like the real ones.
 */
function HeaderTools() {
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (id: string) => setOpen((current) => (current === id ? null : id));
  return (
    <div className="flex items-center gap-1.5">
      {DEV_TOOLS.map(({ id, label, Icon }) => (
        <Hint key={id} side="bottom" sideOffset={4} label={label}>
          <Button
            variant="ghost"
            size="icon"
            aria-label={label}
            aria-pressed={open === id}
            onClick={() => toggle(id)}
            className="text-foreground aria-pressed:bg-active cursor-pointer transition-colors active:scale-[0.96]"
          >
            <Icon className="size-4" />
          </Button>
        </Hint>
      ))}
      <Button
        variant="ghost"
        size="xs"
        aria-pressed={open === 'share'}
        onClick={() => toggle('share')}
        className="aria-pressed:bg-active cursor-pointer rounded-md active:scale-[0.96]"
      >
        <ShareIcon />
        Share
      </Button>
    </div>
  );
}

function Session({ stage }: { stage: Stage }) {
  return (
    <section aria-label="Session" className="bg-background relative flex flex-1 flex-col overflow-hidden">
      <header className="flex h-14 shrink-0 items-center justify-between pr-5 pl-6">
        <div className="flex items-center gap-2.5">
          <span className="text-sm">Northwind revenue dashboard</span>
          <span className="text-muted-foreground">
            <Icon size={12} d="M4 6l4 4 4-4" />
          </span>
        </div>
        <HeaderTools />
      </header>
      <span aria-hidden className="text-muted-foreground absolute top-16 right-6 text-sm">
        «
      </span>
      <Thread stage={stage} />
      <Composer typed={stage.typed} />
    </section>
  );
}

export function SessionWindow({ className }: { className?: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const scale = useFitScale(frame);
  const stage = useScript(frame);

  return (
    <div ref={frame} className={cn('relative w-full', className)} style={{ aspectRatio: `${W} / ${H}` }}>
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{ width: W, height: H, transform: `scale(${scale})` }}
      >
        {/* Glass ring: an 8px lip of the band showing through, then the app. */}
        <div className="bg-background/20 ring-border flex size-full rounded-2xl p-2 ring-1">
          <div className="bg-background text-foreground flex size-full overflow-hidden rounded-xl border">
            <Sidebar />
            <Session stage={stage} />
          </div>
        </div>
      </div>
    </div>
  );
}
