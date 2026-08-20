'use client';

import { cn } from '@/lib/utils';
import {
  ArrowBendUpLeftIcon,
  ArrowsSplitIcon,
  AtIcon,
  BroadcastIcon,
  ChatsCircleIcon,
  CheckSquareIcon,
  ClockIcon,
  CpuIcon,
  CursorIcon,
  FileCodeIcon,
  FilesIcon,
  FingerprintIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  GridFourIcon,
  HardDrivesIcon,
  IdentificationBadgeIcon,
  KeyIcon,
  ListChecksIcon,
  LockKeyIcon,
  PlugsConnectedIcon,
  PowerIcon,
  PulseIcon,
  ReceiptIcon,
  SealCheckIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SquaresFourIcon,
  StackIcon,
  TagIcon,
  TerminalWindowIcon,
  TreeStructureIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react';
import { m } from 'motion/react';
import { useEffect, useId, useState, type ReactNode } from 'react';

/**
 * The capability-hero artifact vocabulary.
 *
 * Every capability page picks four of these, chosen to depict *that page's*
 * claim — a cron page gets a firing schedule matrix, a secrets page gets a
 * plaintext→ciphertext morph. Shared concepts intentionally share an artifact:
 * four pages end on "change request to main", and all four render `diff`.
 *
 * MOTION CONTRACT — every artifact plays **once** when its card arrives, then
 * rests. Nothing here loops. A marketing animation earns its place by
 * explaining something, and an explanation that repeats forever stops
 * explaining and becomes ambient noise. The single exception is the caret in
 * `terminal`, a shell idiom that carries real meaning: this prompt is live.
 *
 * They stay one family because every one is built from the same five atoms
 * below, on one palette (`muted-foreground` inert → `foreground` resolved) and
 * one tempo (60ms stagger, ~300ms reveal, ease-out).
 */
export type CapabilityHeroVisual =
  | 'signal'
  | 'terminal'
  | 'diff'
  | 'isolation'
  | 'boot'
  | 'tree'
  | 'repo'
  | 'gate'
  | 'lanes'
  | 'cron'
  | 'signature'
  | 'identity'
  | 'presence'
  | 'thread'
  | 'reply'
  | 'approve'
  | 'declare'
  | 'commits'
  | 'apps'
  | 'vault'
  | 'policy'
  | 'protocols'
  | 'encrypt'
  | 'principals'
  | 'stack'
  | 'providers'
  | 'versions'
  | 'grants'
  | 'sso'
  | 'roles'
  | 'audit'
  | 'airgap';

export type CapabilityHeroSpec = {
  readonly k: string;
  readonly v: string;
  readonly visual?: CapabilityHeroVisual;
};

export type ArtifactProps = {
  spec: CapabilityHeroSpec;
  reduceMotion: boolean;
};

/** The blessed ease-out. Everything here enters, so nothing uses ease-in. */
const EASE_OUT = [0.23, 1, 0.32, 1] as const;
/** Per-item stagger. Doctrine range is 30–80ms. */
const STEP = 0.06;
/** Lets the card land before its contents start arriving. */
const LEAD = 0.14;

/** Standard reveal for one element of an artifact. */
function reveal(index: number, reduceMotion: boolean) {
  return {
    initial: reduceMotion ? false : { opacity: 0, y: 6 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.3, delay: LEAD + index * STEP, ease: EASE_OUT },
  } as const;
}

/* ------------------------------------------------------------------- hooks */

/**
 * Steps 0 → length-1 once on a beat, then stops. Disabled (reduced motion)
 * returns the final index, so the artifact shows its resolved state rather
 * than its starting one.
 */
function useSteps(length: number, ms: number, enabled: boolean): number {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!enabled || length <= 1) return;
    const id = setInterval(() => {
      setIndex((n) => (n >= length - 1 ? n : n + 1));
    }, ms);
    return () => clearInterval(id);
  }, [length, ms, enabled]);

  return enabled ? index : length - 1;
}

const GLYPHS = '0123456789abcdef';

/**
 * Resolves `target` left-to-right once, then holds. Derived from a counter
 * rather than `Math.random`, so the first paint is identical on the server and
 * the client.
 */
function useHexScramble(target: string, enabled: boolean): string {
  const tick = useSteps(target.length + 8, 70, enabled);

  if (!enabled) return target;

  const revealed = Math.max(0, Math.min(target.length, tick - 4));
  return target
    .split('')
    .map((char, i) => (i < revealed ? char : GLYPHS[(tick + i * 7) % GLYPHS.length]))
    .join('');
}

/* ------------------------------------------------------------------- atoms */

/** Every artifact fills this band, so heights never disagree between cards. */
function Band({ children, className }: { children: ReactNode; className?: string }): ReactNode {
  return (
    <div className={cn('flex h-full w-full flex-col justify-center', className)}>{children}</div>
  );
}

function Chip({ label, active }: { label: string; active?: boolean }): ReactNode {
  return (
    <span
      className={cn(
        'rounded-full border px-2 py-0.5 font-mono text-[11px] whitespace-nowrap',
        active
          ? 'border-foreground/40 bg-foreground/10 text-foreground'
          : 'border-border text-muted-foreground/60',
      )}
    >
      {label}
    </span>
  );
}

function Bar({
  width,
  active,
  index = 0,
  reduceMotion,
}: {
  width: string;
  active?: boolean;
  index?: number;
  reduceMotion: boolean;
}): ReactNode {
  return (
    <m.span
      className={cn(
        'block h-2 origin-left rounded-full',
        active ? 'bg-foreground/45' : 'bg-muted-foreground/20',
      )}
      style={{ width }}
      initial={reduceMotion ? false : { scaleX: 0, opacity: 0 }}
      animate={{ scaleX: 1, opacity: 1 }}
      transition={{ duration: 0.36, delay: LEAD + index * STEP, ease: EASE_OUT }}
    />
  );
}

function Node({ active, filled }: { active?: boolean; filled?: boolean }): ReactNode {
  return (
    <span
      className={cn(
        'ring-card block size-2.5 shrink-0 rounded-full border ring-4',
        active || filled ? 'border-foreground bg-foreground' : 'border-border bg-background',
      )}
    />
  );
}

function MonoRow({
  children,
  active,
  className,
}: {
  children: ReactNode;
  active?: boolean;
  className?: string;
}): ReactNode {
  return (
    <span
      className={cn(
        'flex items-center gap-2 font-mono text-[11px]',
        active ? 'text-foreground' : 'text-muted-foreground/60',
        className,
      )}
    >
      {children}
    </span>
  );
}

function Cell({ active, className }: { active: boolean; className?: string }): ReactNode {
  return (
    <span
      className={cn(
        'block rounded-[2px]',
        active ? 'bg-foreground/70' : 'bg-muted-foreground/15',
        className,
      )}
    />
  );
}

/* --------------------------------------------------------------- sparkline */

const SIGNAL_W = 132;
const SIGNAL_H = 44;
const SIGNAL_PAD = 6;
const SIGNAL_VALUES = [12, 19, 10, 24, 16, 29, 21, 33, 23, 31, 26, 35, 28, 30] as const;

/** Deterministic smooth polyline — no randomness, so SSR and client agree. */
function buildSignal(values: readonly number[]): { line: string; area: string; endY: number } {
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const step = SIGNAL_W / (values.length - 1);
  const plot = SIGNAL_H - SIGNAL_PAD * 2;
  const points = values.map(
    (value, i) => [i * step, SIGNAL_H - SIGNAL_PAD - ((value - min) / span) * plot] as const,
  );

  const first = points[0] ?? ([0, SIGNAL_H / 2] as const);
  let line = `M ${first[0]},${first[1]}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i];
    const to = points[i + 1];
    if (!from || !to) continue;
    const mid = (from[0] + to[0]) / 2;
    line += ` C ${mid},${from[1]} ${mid},${to[1]} ${to[0]},${to[1]}`;
  }

  const last = points[points.length - 1] ?? first;
  return {
    line,
    area: `${line} L ${SIGNAL_W},${SIGNAL_H} L 0,${SIGNAL_H} Z`,
    endY: last[1],
  };
}

const SIGNAL = buildSignal(SIGNAL_VALUES);

/**
 * Activity trace. It draws once, left to right, then holds.
 *
 * The reveal is an animated `clipPath` rect rather than `pathLength`: the
 * viewBox is stretched with `preserveAspectRatio="none"`, and a non-uniform
 * scale distorts dash-array based draw-on. Clip rects live in user space, so
 * they stay exact at any aspect.
 */
function SignalArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  const clipId = useId();
  const fillId = useId();

  return (
    <div className="text-foreground relative h-full w-full">
      <svg
        viewBox={`0 0 ${SIGNAL_W} ${SIGNAL_H}`}
        preserveAspectRatio="none"
        className="h-full w-full"
        aria-hidden
      >
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
          <clipPath id={clipId}>
            <m.rect
              x="0"
              y="0"
              height={SIGNAL_H}
              initial={{ width: reduceMotion ? SIGNAL_W : 0 }}
              animate={{ width: SIGNAL_W }}
              transition={
                reduceMotion ? { duration: 0 } : { duration: 0.9, delay: LEAD, ease: EASE_OUT }
              }
            />
          </clipPath>
        </defs>

        {[0.28, 0.5, 0.72].map((row) => (
          <line
            key={row}
            x1="0"
            x2={SIGNAL_W}
            y1={SIGNAL_H * row}
            y2={SIGNAL_H * row}
            className="stroke-border"
            strokeWidth="1"
            strokeDasharray="1 4"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        <path
          d={SIGNAL.line}
          fill="none"
          className="stroke-muted-foreground/20"
          strokeWidth="1.5"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />

        <g clipPath={`url(#${clipId})`}>
          <path d={SIGNAL.area} fill={`url(#${fillId})`} />
          <path
            d={SIGNAL.line}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </g>
      </svg>

      <m.span
        className="bg-foreground ring-card absolute right-0 size-1.5 -translate-x-px -translate-y-1/2 rounded-full ring-2"
        style={{ top: `${(SIGNAL.endY / SIGNAL_H) * 100}%` }}
        initial={reduceMotion ? false : { opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.24, delay: LEAD + 0.8, ease: EASE_OUT }}
        aria-hidden
      />
    </div>
  );
}

/* ---------------------------------------------------------------- terminal */

/**
 * A live shell. It deliberately renders no words: the card's statement already
 * says what the command is, and echoing it here read as a duplicated line.
 * Prior output is abstracted to bars, so nothing is claimed that isn't real.
 */
function TerminalArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  return (
    <Band className="justify-center gap-2.5 font-mono text-xs">
      <Bar width="64%" index={0} reduceMotion={reduceMotion} />
      <Bar width="42%" index={1} reduceMotion={reduceMotion} />
      <m.span className="mt-1 flex items-center gap-2" {...reveal(2, reduceMotion)}>
        <span className="text-foreground">$</span>
        <span className="text-muted-foreground/60">kortix</span>
        <span
          className={cn(
            'bg-foreground inline-block h-3.5 w-[0.4rem]',
            !reduceMotion && 'animate-blink-cursor',
          )}
        />
      </m.span>
    </Band>
  );
}

/* -------------------------------------------------------------------- diff */

const DIFF_ROWS = [
  { sign: '-', width: '62%', added: false },
  { sign: '+', width: '86%', added: true },
  { sign: '+', width: '48%', added: true },
] as const;

/** A change request landing: the removed line first, then the additions. */
function DiffArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  return (
    <Band className="gap-3">
      {DIFF_ROWS.map((row, i) => (
        <div key={row.sign + row.width} className="flex items-center gap-2.5">
          <span
            className={cn(
              'w-2 shrink-0 font-mono text-[11px] leading-none',
              row.added ? 'text-foreground/70' : 'text-muted-foreground/45',
            )}
          >
            {row.sign}
          </span>
          <Bar width={row.width} active={row.added} index={i} reduceMotion={reduceMotion} />
        </div>
      ))}
    </Band>
  );
}

/* --------------------------------------------------------------- isolation */

/** Four sandboxes, one occupied. Nothing is ever shared. */
function IsolationArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  return (
    <Band className="flex-row items-center gap-2">
      {[0, 1, 2, 3].map((cell) => (
        <m.span
          key={cell}
          className={cn(
            'flex h-12 flex-1 items-center justify-center rounded-sm border',
            cell === 1
              ? 'border-foreground/40 bg-foreground/[0.07]'
              : 'border-border bg-background/30',
          )}
          {...reveal(cell, reduceMotion)}
        >
          <span
            className={cn(
              'size-1.5 rounded-full',
              cell === 1 ? 'bg-foreground' : 'bg-muted-foreground/25',
            )}
          />
        </m.span>
      ))}
    </Band>
  );
}

/* -------------------------------------------------------------------- boot */

const BOOT_STEPS = ['repo', 'tools', 'deps'] as const;

/** Boot sequence: each layer checks off in order, then it is up. */
function BootArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  const step = useSteps(BOOT_STEPS.length + 1, 260, !reduceMotion);

  return (
    <Band className="gap-3">
      {BOOT_STEPS.map((label, i) => {
        const done = step > i;
        return (
          <MonoRow key={label} active={done}>
            <span
              className={cn(
                'flex size-3.5 items-center justify-center rounded-[3px] border text-[9px] transition-colors duration-200',
                done
                  ? 'border-foreground/50 bg-foreground/15 text-foreground'
                  : 'border-border text-transparent',
              )}
            >
              ✓
            </span>
            <span className="truncate">{label}</span>
            <span
              className={cn(
                'ml-auto h-px flex-1 transition-colors duration-200',
                done ? 'bg-foreground/25' : 'bg-border',
              )}
            />
          </MonoRow>
        );
      })}
    </Band>
  );
}

/* -------------------------------------------------------------------- tree */

const TREE_ROWS = [
  { label: 'skills/', indent: 0 },
  { label: 'research/', indent: 1 },
  { label: 'SKILL.md', indent: 2 },
] as const;

/** A skill is just a folder — the file at the bottom is the whole contract. */
function TreeArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  return (
    <Band className="gap-2.5">
      {TREE_ROWS.map((row, i) => {
        const leaf = i === TREE_ROWS.length - 1;
        return (
          <m.span
            key={row.label}
            className={cn(
              'flex items-center gap-2 font-mono text-[11px]',
              leaf ? 'text-foreground' : 'text-muted-foreground/60',
            )}
            style={{ paddingLeft: `${row.indent * 0.9}rem` }}
            {...reveal(i, reduceMotion)}
          >
            <span
              className={cn(
                'size-1.5 shrink-0 rounded-[2px]',
                leaf ? 'bg-foreground' : 'bg-muted-foreground/30',
              )}
            />
            <span className="truncate">{row.label}</span>
          </m.span>
        );
      })}
    </Band>
  );
}

/* -------------------------------------------------------------------- repo */

const REPO_FILES = ['kortix.yaml', 'agents/', 'skills/', 'commands/'] as const;

/** Configuration is files. Four of them, in a repo with your name on it. */
function RepoArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  return (
    <Band className="flex-row flex-wrap content-center gap-2">
      {REPO_FILES.map((file, i) => (
        <m.span key={file} {...reveal(i, reduceMotion)}>
          <Chip label={file} active={i === 0} />
        </m.span>
      ))}
    </Band>
  );
}

/* -------------------------------------------------------------------- gate */

const GATE_ROWS = [
  { verdict: '✕', allowed: false },
  { verdict: '✕', allowed: false },
  { verdict: '✓', allowed: true },
] as const;

/** Deny by default: the exception is the one row that carries a grant. */
function GateArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  return (
    <Band className="gap-3">
      {GATE_ROWS.map((row, i) => (
        <m.span key={i} className="flex items-center gap-2.5" {...reveal(i, reduceMotion)}>
          <span
            className={cn(
              'w-2.5 shrink-0 text-center font-mono text-[11px]',
              row.allowed ? 'text-foreground' : 'text-muted-foreground/40',
            )}
          >
            {row.verdict}
          </span>
          <span
            className={cn(
              'h-2 flex-1 rounded-full',
              row.allowed ? 'bg-foreground/40' : 'bg-muted-foreground/15',
            )}
          />
        </m.span>
      ))}
    </Band>
  );
}

/* ------------------------------------------------------------------- lanes */

/** Two ways in: a scheduled beat on one lane, an inbound call on the other. */
function LanesArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  return (
    <Band className="gap-6">
      {['cron', 'hook'].map((label, i) => (
        <m.div key={label} className="flex items-center gap-3" {...reveal(i, reduceMotion)}>
          <span className="text-muted-foreground/60 w-8 shrink-0 font-mono text-[11px]">
            {label}
          </span>
          <span className="bg-border relative h-px flex-1">
            {reduceMotion ? null : (
              <m.span
                className="absolute inset-y-0 left-0 w-full"
                initial={{ x: '0%' }}
                animate={{ x: '100%' }}
                transition={{ duration: 0.7, delay: LEAD + 0.1 + i * 0.16, ease: EASE_OUT }}
              >
                <span className="bg-foreground absolute top-1/2 left-0 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full" />
              </m.span>
            )}
          </span>
          <Node filled />
        </m.div>
      ))}
    </Band>
  );
}

/* -------------------------------------------------------------------- cron */

/** Six fields, five slots each — the lit cells are the schedule. */
const CRON_PATTERN = [
  [1, 0, 1, 0, 0],
  [0, 1, 0, 1, 0],
  [1, 1, 0, 0, 1],
  [0, 0, 1, 0, 1],
  [1, 0, 0, 1, 0],
  [0, 1, 1, 0, 0],
] as const;

function CronArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  return (
    <Band className="flex-row items-center justify-between gap-1.5">
      {CRON_PATTERN.map((column, field) => (
        <m.span key={field} className="flex flex-1 flex-col gap-1" {...reveal(field, reduceMotion)}>
          {column.map((slot, i) => (
            <Cell key={i} active={slot === 1} className="h-2 w-full" />
          ))}
        </m.span>
      ))}
    </Band>
  );
}

/* --------------------------------------------------------------- signature */

const DIGEST = 'a7f3c1d2e9b40856';

/** The digest resolves once. An unsigned request never gets one. */
function SignatureArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  const digest = useHexScramble(DIGEST, !reduceMotion);
  const settled = digest === DIGEST;

  return (
    <Band className="gap-3">
      <MonoRow>
        <span className="tracking-wider uppercase">sha256</span>
        <span className="bg-border h-px flex-1" />
        <span
          className={cn(
            'transition-colors duration-200',
            settled ? 'text-foreground' : 'text-muted-foreground/40',
          )}
        >
          {settled ? 'signed' : '·····'}
        </span>
      </MonoRow>
      <span className="text-foreground block truncate font-mono text-sm tabular-nums">
        {digest}
      </span>
    </Band>
  );
}

/* ---------------------------------------------------------------- identity */

/** A run is attributed to an agent you named, not an anonymous process. */
function IdentityArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  return (
    <Band className="flex-row items-center gap-3">
      <m.span
        className="border-border bg-background/50 flex size-10 shrink-0 items-center justify-center rounded-sm border"
        {...reveal(0, reduceMotion)}
      >
        <AtIcon className="text-foreground size-4" aria-hidden />
      </m.span>
      <span className="flex min-w-0 flex-1 flex-col gap-2.5">
        <m.span
          className="border-border/70 flex h-6 items-center rounded-sm border border-dashed px-2"
          {...reveal(1, reduceMotion)}
        >
          <span className="bg-foreground/35 h-1.5 w-16 rounded-full" />
        </m.span>
        <m.span
          className="bg-muted-foreground/15 h-2 w-2/3 rounded-full"
          {...reveal(2, reduceMotion)}
        />
      </span>
    </Band>
  );
}

/* ---------------------------------------------------------------- presence */

const PRESENCE_ROWS = [
  { label: 'slack', live: true },
  { label: 'teams', live: false },
  { label: 'discord', live: false },
] as const;

/** One channel is live today; the rest are wiring, not promises. */
function PresenceArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  return (
    <Band className="gap-3">
      {PRESENCE_ROWS.map((row, i) => (
        <m.span key={row.label} className="flex items-center gap-2.5" {...reveal(i, reduceMotion)}>
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              row.live ? 'bg-foreground' : 'bg-muted-foreground/25',
            )}
          />
          <span
            className={cn(
              'w-14 shrink-0 font-mono text-[11px]',
              row.live ? 'text-foreground' : 'text-muted-foreground/45',
            )}
          >
            {row.label}
          </span>
          <span
            className={cn(
              'h-2 rounded-full',
              row.live ? 'bg-foreground/40 flex-1' : 'bg-muted-foreground/15 w-10',
            )}
          />
        </m.span>
      ))}
    </Band>
  );
}

/* ------------------------------------------------------------------ thread */

/** Three messages, one bracket: the thread *is* the session boundary. */
function ThreadArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  return (
    <Band className="flex-row items-stretch gap-3">
      <m.span
        className="border-foreground/40 w-2 shrink-0 origin-top rounded-l-sm border-y border-l"
        initial={reduceMotion ? false : { scaleY: 0, opacity: 0 }}
        animate={{ scaleY: 1, opacity: 1 }}
        transition={{ duration: 0.36, delay: LEAD, ease: EASE_OUT }}
      />
      <span className="flex flex-1 flex-col justify-center gap-3">
        {['86%', '62%', '74%'].map((width, i) => (
          <Bar
            key={width}
            width={width}
            active={i === 1}
            index={i + 1}
            reduceMotion={reduceMotion}
          />
        ))}
      </span>
    </Band>
  );
}

/* ------------------------------------------------------------------- reply */

/** The answer comes back indented under the message that asked for it. */
function ReplyArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  return (
    <Band className="gap-3.5">
      <Bar width="70%" index={0} reduceMotion={reduceMotion} />
      <m.span className="flex items-center gap-2 pl-6" {...reveal(2, reduceMotion)}>
        <ArrowBendUpLeftIcon
          className="text-muted-foreground/40 size-3.5 shrink-0 scale-y-[-1]"
          aria-hidden
        />
        <span className="bg-foreground/40 block h-2 w-[58%] rounded-full" />
      </m.span>
    </Band>
  );
}

/* ----------------------------------------------------------------- approve */

/** The decision is two buttons on a card, not a console someone has to open. */
function ApproveArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  return (
    <Band className="gap-3.5">
      <Bar width="76%" index={0} reduceMotion={reduceMotion} />
      <m.span className="relative flex items-center gap-2" {...reveal(2, reduceMotion)}>
        <span className="border-foreground/50 bg-foreground/10 text-foreground rounded-sm border px-2.5 py-1 font-mono text-[11px]">
          Approve
        </span>
        <span className="border-border text-muted-foreground/40 rounded-sm border px-2.5 py-1 font-mono text-[11px]">
          Deny
        </span>
        {reduceMotion ? null : (
          <m.span
            className="pointer-events-none absolute top-1/2 left-8"
            initial={{ y: 12, opacity: 0 }}
            animate={{ y: 2, opacity: 1 }}
            transition={{ duration: 0.34, delay: LEAD + 0.34, ease: EASE_OUT }}
          >
            <CursorIcon className="text-foreground size-4" weight="fill" aria-hidden />
          </m.span>
        )}
      </m.span>
    </Band>
  );
}

/* ----------------------------------------------------------------- declare */

const DECLARE_LINES = [
  { key: 'runtime', value: 'opencode' },
  { key: 'model', value: 'declared' },
] as const;

/** The runtime is a line in a file, not a setting in a dashboard. */
function DeclareArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  return (
    <Band className="gap-3 font-mono text-[11px]">
      {DECLARE_LINES.map((line, i) => (
        <m.span key={line.key} className="flex items-center gap-1.5" {...reveal(i, reduceMotion)}>
          <span className="text-muted-foreground/50">{line.key}:</span>
          <span className={i === 0 ? 'text-foreground' : 'text-muted-foreground/70'}>
            {line.value}
          </span>
        </m.span>
      ))}
    </Band>
  );
}

/* ----------------------------------------------------------------- commits */

const COMMITS = ['4bda16e', '7b3ff2c', '3ebc979'] as const;

/** Every change is a commit — addressable, diffable, revertable. */
function CommitsArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  return (
    <Band className="flex-row items-center">
      {COMMITS.map((sha, i) => (
        <m.span
          key={sha}
          className="flex flex-1 items-center last:flex-none"
          {...reveal(i, reduceMotion)}
        >
          <span className="flex flex-col items-center gap-2">
            <Node active={i === COMMITS.length - 1} filled={i === COMMITS.length - 1} />
            <span
              className={cn(
                'font-mono text-[11px]',
                i === COMMITS.length - 1 ? 'text-foreground' : 'text-muted-foreground/45',
              )}
            >
              {sha}
            </span>
          </span>
          {i < COMMITS.length - 1 ? (
            <span className="bg-border -mt-6 h-px flex-1 self-center" />
          ) : null}
        </m.span>
      ))}
    </Band>
  );
}

/* -------------------------------------------------------------------- apps */

/** A catalogue too large to name — so it reads as a field, not a list. */
const APPS_PATTERN = [
  [1, 0, 1, 1, 0, 1, 0, 1],
  [0, 1, 1, 0, 1, 0, 1, 1],
  [1, 1, 0, 1, 0, 1, 1, 0],
] as const;

function AppsArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  return (
    <Band className="gap-1.5">
      {APPS_PATTERN.map((row, i) => (
        <m.span key={i} className="flex gap-1.5" {...reveal(i, reduceMotion)}>
          {row.map((lit, col) => (
            <Cell key={col} active={lit === 1} className="h-3 flex-1" />
          ))}
        </m.span>
      ))}
    </Band>
  );
}

/* ------------------------------------------------------------------- vault */

/** The key stops at the boundary. Only the call crosses it. */
function VaultArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  return (
    <Band className="flex-row items-center gap-3">
      <m.span
        className="border-border bg-background/50 flex size-10 shrink-0 items-center justify-center rounded-sm border"
        {...reveal(0, reduceMotion)}
      >
        <KeyIcon className="text-muted-foreground size-4" aria-hidden />
      </m.span>

      <span className="relative h-10 flex-1">
        <span className="bg-border absolute inset-x-0 top-1/2 h-px -translate-y-1/2" />
        {reduceMotion ? null : (
          <m.span
            className="bg-foreground absolute top-1/2 left-0 size-1.5 -translate-y-1/2 rounded-full"
            initial={{ x: 0, opacity: 0 }}
            animate={{ x: 44, opacity: [0, 1, 1, 0] }}
            transition={{ duration: 0.8, delay: LEAD + 0.12, ease: EASE_OUT }}
          />
        )}
        <span className="border-border/80 absolute inset-y-0 right-0 border-l border-dashed" />
      </span>

      <m.span
        className="border-foreground/40 bg-foreground/[0.06] flex size-10 shrink-0 items-center justify-center rounded-sm border border-dashed"
        {...reveal(1, reduceMotion)}
      >
        <CpuIcon className="text-foreground size-4" aria-hidden />
      </m.span>
    </Band>
  );
}

/* ------------------------------------------------------------------ policy */

const POLICY_ROWS = [
  { label: 'allow', width: 'flex-1', active: true },
  { label: 'ask', width: 'w-2/3', active: false },
  { label: 'block', width: 'w-1/3', active: false },
] as const;

/** Three verdicts. Every tool call resolves to exactly one of them. */
function PolicyArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  return (
    <Band className="gap-3">
      {POLICY_ROWS.map((row, i) => (
        <m.span key={row.label} {...reveal(i, reduceMotion)}>
          <MonoRow active={row.active}>
            <span
              className={cn(
                'block size-1.5 shrink-0 rounded-full',
                row.active ? 'bg-foreground' : 'bg-muted-foreground/25',
              )}
            />
            <span className="w-11 shrink-0">{row.label}</span>
            <span
              className={cn(
                'h-2 rounded-full',
                row.width,
                row.active ? 'bg-foreground/40' : 'bg-muted-foreground/15',
              )}
            />
          </MonoRow>
        </m.span>
      ))}
    </Band>
  );
}

/* --------------------------------------------------------------- protocols */

const PROTOCOLS = ['MCP', 'OpenAPI', 'GraphQL', 'HTTP'] as const;

/** Four ways to bring your own API in. */
function ProtocolsArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  return (
    <Band className="flex-row flex-wrap content-center gap-2">
      {PROTOCOLS.map((protocol, i) => (
        <m.span key={protocol} {...reveal(i, reduceMotion)}>
          <Chip label={protocol} />
        </m.span>
      ))}
    </Band>
  );
}

/* ----------------------------------------------------------------- encrypt */

const CIPHER = 'e4b1d79c7af05263';

/** Plaintext goes in, ciphertext comes out, the key never leaves the project. */
function EncryptArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  const cipher = useHexScramble(CIPHER, !reduceMotion);

  return (
    <Band className="gap-3">
      <m.span className="flex items-center gap-3" {...reveal(0, reduceMotion)}>
        <span className="bg-muted-foreground/20 h-2 w-1/2 rounded-full" />
        <LockKeyIcon className="text-foreground size-3.5 shrink-0" aria-hidden />
      </m.span>
      <span className="text-foreground block truncate font-mono text-sm tabular-nums">
        {cipher}
      </span>
    </Band>
  );
}

/* -------------------------------------------------------------- principals */

const PRINCIPALS = [
  { shape: 'rounded-full', label: 'person' },
  { shape: 'rounded-[3px]', label: 'service' },
] as const;

/** Two kinds of actor, one permission model. */
function PrincipalsArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  return (
    <Band className="gap-4">
      {PRINCIPALS.map((row, i) => (
        <m.span key={row.label} className="flex items-center gap-3" {...reveal(i, reduceMotion)}>
          <span
            className={cn(
              'border-border bg-background/60 block size-6 shrink-0 border',
              row.shape,
              i === 1 && 'border-foreground/50 bg-foreground/10',
            )}
          />
          <span className="text-muted-foreground/60 w-14 shrink-0 font-mono text-[11px]">
            {row.label}
          </span>
          <span
            className={cn(
              'h-2 flex-1 rounded-full',
              i === 1 ? 'bg-foreground/35' : 'bg-muted-foreground/20',
            )}
          />
        </m.span>
      ))}
    </Band>
  );
}

/* ------------------------------------------------------------------- stack */

const STACK_SERVICES = ['web', 'api', 'db', 'cache'] as const;

/** One compose project — the services come up together, bottom-up. */
function StackArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  const up = useSteps(STACK_SERVICES.length + 1, 220, !reduceMotion);

  return (
    <Band className="gap-1.5">
      {STACK_SERVICES.map((service, i) => {
        const running = up > STACK_SERVICES.length - 1 - i;
        return (
          <m.span
            key={service}
            className={cn(
              'flex h-6 items-center gap-2 rounded-[3px] border px-2 transition-colors duration-200',
              running
                ? 'border-foreground/40 bg-foreground/[0.07]'
                : 'border-border bg-background/30',
            )}
            {...reveal(i, reduceMotion)}
          >
            <span
              className={cn(
                'size-1 shrink-0 rounded-full transition-colors duration-200',
                running ? 'bg-foreground' : 'bg-muted-foreground/25',
              )}
            />
            <span
              className={cn(
                'font-mono text-[11px] transition-colors duration-200',
                running ? 'text-foreground' : 'text-muted-foreground/45',
              )}
            >
              {service}
            </span>
          </m.span>
        );
      })}
    </Band>
  );
}

/* --------------------------------------------------------------- providers */

const PROVIDERS = ['provider a', 'provider b', 'provider c'] as const;

/** Your provider, your key — the slot is filled by you, not by us. */
function ProvidersArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  return (
    <Band className="gap-3.5">
      {PROVIDERS.map((provider, i) => (
        <m.span key={provider} {...reveal(i, reduceMotion)}>
          <MonoRow active>
            <KeyIcon className="text-foreground size-3.5 shrink-0" aria-hidden />
            <span className="bg-foreground/30 h-2 flex-1 rounded-full" />
          </MonoRow>
        </m.span>
      ))}
    </Band>
  );
}

/* ---------------------------------------------------------------- versions */

const VERSIONS = ['v1.4', 'v1.5', 'nightly'] as const;
const PINNED = 1;

/** Track the head, or drive a pin into a version and stay there. */
function VersionsArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  return (
    <Band className="gap-4">
      <span className="relative flex items-center">
        <span className="bg-border absolute inset-x-0 top-1/2 h-px -translate-y-1/2" />
        {VERSIONS.map((version, i) => (
          <m.span
            key={version}
            className="relative flex flex-1 justify-center last:flex-none"
            {...reveal(i, reduceMotion)}
          >
            <Node active={i === PINNED} filled={i === VERSIONS.length - 1} />
          </m.span>
        ))}
      </span>
      <span className="flex items-center justify-between">
        {VERSIONS.map((version, i) => (
          <span
            key={version}
            className={cn(
              'font-mono text-[11px]',
              i === PINNED ? 'text-foreground' : 'text-muted-foreground/45',
            )}
          >
            {version}
          </span>
        ))}
      </span>
    </Band>
  );
}

/* ------------------------------------------------------------------ grants */

const GRANTS = ['repo', 'tools', 'connectors'] as const;

/** An agent is a runtime plus the grants attached to it. */
function GrantsArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  return (
    <Band className="flex-row items-center gap-3">
      <m.span
        className="border-foreground/40 bg-foreground/10 flex size-10 shrink-0 items-center justify-center rounded-sm border"
        {...reveal(0, reduceMotion)}
      >
        <AtIcon className="text-foreground size-4" aria-hidden />
      </m.span>
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        {GRANTS.map((grant, i) => (
          <m.span key={grant} className="flex items-center gap-2" {...reveal(i + 1, reduceMotion)}>
            <span className="bg-border h-px w-3 shrink-0" />
            <Chip label={grant} />
          </m.span>
        ))}
      </span>
    </Band>
  );
}

/* --------------------------------------------------------------------- sso */

/** The identity provider asserts; the app accepts. No second password. */
function SsoArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  return (
    <Band className="flex-row items-center gap-3">
      <m.span
        className="border-border bg-background/50 text-muted-foreground/70 flex size-10 shrink-0 items-center justify-center rounded-sm border font-mono text-[11px] uppercase"
        {...reveal(0, reduceMotion)}
      >
        idp
      </m.span>

      <span className="relative h-10 flex-1">
        <span className="bg-border absolute inset-x-0 top-1/2 h-px -translate-y-1/2" />
        {reduceMotion ? null : (
          <m.span
            className="absolute inset-y-0 left-0 flex w-full items-center"
            initial={{ x: '0%', opacity: 0 }}
            animate={{ x: '100%', opacity: [0, 1, 1, 0] }}
            transition={{ duration: 0.85, delay: LEAD + 0.12, ease: EASE_OUT }}
          >
            <span className="border-foreground/40 bg-card text-foreground -translate-x-1/2 rounded-full border px-1.5 py-px font-mono text-[10px] uppercase">
              saml
            </span>
          </m.span>
        )}
      </span>

      <m.span
        className="border-foreground/40 bg-foreground/10 text-foreground flex size-10 shrink-0 items-center justify-center rounded-sm border"
        initial={reduceMotion ? false : { opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.28, delay: LEAD + 0.85, ease: EASE_OUT }}
      >
        <SealCheckIcon className="size-4" weight="fill" aria-hidden />
      </m.span>
    </Band>
  );
}

/* ------------------------------------------------------------------- roles */

const ROLES = ['owner', 'admin', 'member'] as const;
/** Row = role, column = permission. Reach narrows as you go down. */
const ROLE_GRANTS: readonly (readonly number[])[] = [
  [1, 1, 1, 1],
  [1, 1, 1, 0],
  [1, 0, 0, 0],
];

function RolesArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  return (
    <Band className="gap-2.5">
      {ROLES.map((role, i) => (
        <m.span key={role} {...reveal(i, reduceMotion)}>
          <MonoRow active={i === 0}>
            <span className="w-12 shrink-0">{role}</span>
            <span className="flex flex-1 gap-1.5">
              {(ROLE_GRANTS[i] ?? []).map((granted, col) => (
                <Cell key={col} active={granted === 1} className="h-2.5 flex-1" />
              ))}
            </span>
          </MonoRow>
        </m.span>
      ))}
    </Band>
  );
}

/* ------------------------------------------------------------------- audit */

const AUDIT_EVENTS = [
  ['09:12:04', 'session.start'],
  ['09:12:31', 'tool.invoke'],
  ['09:13:02', 'policy.allow'],
] as const;

/** An append-only record: every line stays, nothing is rewritten. */
function AuditArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  return (
    <Band className="gap-3">
      {AUDIT_EVENTS.map((event, i) => (
        <m.span
          key={event[0]}
          className="flex items-center gap-3 font-mono text-[11px] whitespace-nowrap"
          {...reveal(i, reduceMotion)}
        >
          <span className="text-muted-foreground/45 tabular-nums">{event[0]}</span>
          <span
            className={
              i === AUDIT_EVENTS.length - 1 ? 'text-foreground' : 'text-muted-foreground/60'
            }
          >
            {event[1]}
          </span>
        </m.span>
      ))}
    </Band>
  );
}

/* ------------------------------------------------------------------ airgap */

/** Inside the perimeter it runs. Across it, nothing does. */
function AirgapArtifact({ reduceMotion }: ArtifactProps): ReactNode {
  return (
    <Band className="flex-row items-center gap-2">
      <m.span
        className="border-border flex h-12 flex-1 items-center gap-3 rounded-sm border border-dashed px-3"
        {...reveal(0, reduceMotion)}
      >
        <Node filled />
        <span className="bg-border relative h-px flex-1">
          {reduceMotion ? null : (
            <m.span
              className="absolute inset-y-0 left-0 w-full"
              initial={{ x: '0%' }}
              animate={{ x: '100%' }}
              transition={{ duration: 0.75, delay: LEAD + 0.16, ease: EASE_OUT }}
            >
              <span className="bg-foreground absolute top-1/2 left-0 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full" />
            </m.span>
          )}
        </span>
        <Node filled />
      </m.span>

      <m.span
        className="text-muted-foreground/40 shrink-0 font-mono text-xs leading-none"
        {...reveal(1, reduceMotion)}
      >
        ✕
      </m.span>
    </Band>
  );
}

/* ---------------------------------------------------------------- registry */

export const CAPABILITY_ARTIFACTS: Record<
  CapabilityHeroVisual,
  (props: ArtifactProps) => ReactNode
> = {
  signal: SignalArtifact,
  terminal: TerminalArtifact,
  diff: DiffArtifact,
  isolation: IsolationArtifact,
  boot: BootArtifact,
  tree: TreeArtifact,
  repo: RepoArtifact,
  gate: GateArtifact,
  lanes: LanesArtifact,
  cron: CronArtifact,
  signature: SignatureArtifact,
  identity: IdentityArtifact,
  presence: PresenceArtifact,
  thread: ThreadArtifact,
  reply: ReplyArtifact,
  approve: ApproveArtifact,
  declare: DeclareArtifact,
  commits: CommitsArtifact,
  apps: AppsArtifact,
  vault: VaultArtifact,
  policy: PolicyArtifact,
  protocols: ProtocolsArtifact,
  encrypt: EncryptArtifact,
  principals: PrincipalsArtifact,
  stack: StackArtifact,
  providers: ProvidersArtifact,
  versions: VersionsArtifact,
  grants: GrantsArtifact,
  sso: SsoArtifact,
  roles: RolesArtifact,
  audit: AuditArtifact,
  airgap: AirgapArtifact,
};

export const CAPABILITY_ARTIFACT_ICONS: Record<CapabilityHeroVisual, typeof PulseIcon> = {
  signal: PulseIcon,
  terminal: TerminalWindowIcon,
  diff: GitPullRequestIcon,
  isolation: SquaresFourIcon,
  boot: PowerIcon,
  tree: TreeStructureIcon,
  repo: FilesIcon,
  gate: ShieldCheckIcon,
  lanes: ArrowsSplitIcon,
  cron: ClockIcon,
  signature: FingerprintIcon,
  identity: AtIcon,
  presence: BroadcastIcon,
  thread: ChatsCircleIcon,
  reply: ArrowBendUpLeftIcon,
  approve: CheckSquareIcon,
  declare: FileCodeIcon,
  commits: GitCommitIcon,
  apps: GridFourIcon,
  vault: KeyIcon,
  policy: SlidersHorizontalIcon,
  protocols: PlugsConnectedIcon,
  encrypt: LockKeyIcon,
  principals: UsersThreeIcon,
  stack: StackIcon,
  providers: CpuIcon,
  versions: TagIcon,
  grants: SealCheckIcon,
  sso: IdentificationBadgeIcon,
  roles: ListChecksIcon,
  audit: ReceiptIcon,
  airgap: HardDrivesIcon,
};

/** Fallback order when a spec omits `visual`. */
export const DEFAULT_VISUALS: readonly CapabilityHeroVisual[] = [
  'signal',
  'terminal',
  'lanes',
  'diff',
];
