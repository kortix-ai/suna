'use client';

import { Badge } from '@/components/ui/badge';
import { KortixLogo } from '@/components/ui/kortix-logo';
import { IconFrame } from '@/components/ui/marketing/icon-frame';
import { APPS } from '@/features/marketing/how-it-work/step/step-connectors';
import { Github } from '@/features/icon/icons/github';
import { Slack } from '@/features/icon/icons/slack';
import { faviconUrlForHostname } from '@/lib/favicon';
import { cn } from '@/lib/utils';
import {
  BuildingsIcon,
  CloudIcon,
  ClockIcon,
  GitPullRequestIcon,
  HardDrivesIcon,
  MonitorIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react';
import { Footage, useFrame } from '../../engine/film';
import { ease, fall, interp, rise, span, stagger, typed } from '../../engine/time';
import { Headline, Window } from './parts';

/* ── Beat 7 · every app, any model ──────────────────────────────────────── */

const WALL_COLS = 13;
const WALL = Array.from({ length: 6 }, (_, r) => APPS.slice(r * WALL_COLS, r * WALL_COLS + WALL_COLS));

/** Served from `public/provider-icons`, painted in ink through a mask. */
const MODELS = ['anthropic', 'openai', 'google', 'deepseek', 'mistral', 'xai', 'moonshotai'];

export function Connectors() {
  const f = useFrame();
  const recede = interp(f, 176, 214, 0, 1, ease.inOutCubic);
  const first = f < 190 ? rise(f, 110) : fall(f, 184, { blur: 8 });

  return (
    <div className="absolute inset-0">
      <div
        className="absolute inset-0 flex flex-col items-center justify-center gap-3 mask-y-from-60% mask-y-to-100% mask-x-from-70% mask-x-to-100%"
        style={{
          opacity: 1 - 0.85 * recede,
          filter: `blur(${4 * recede}px)`,
          transform: `scale(${1 - 0.08 * recede})`,
        }}
      >
        {WALL.map((row, r) => (
          <div key={r} className="flex flex-none gap-3" style={{ transform: r % 2 ? 'translateX(38px)' : undefined }}>
            {row.map((domain, c) => {
              const d = Math.hypot(c - (WALL_COLS - 1) / 2, (r - 2.5) * 1.6);
              return (
                <div
                  key={domain}
                  className="border-border bg-popover grid size-16 flex-none place-items-center rounded-2xl border"
                  style={rise(f, 8 + d * 5, { dist: 0, scale: 0.86 })}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={faviconUrlForHostname(domain)} alt="" className="size-8 object-contain" />
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div
        className="absolute top-1/2 left-1/2 size-32 -translate-1/2"
        style={{ opacity: 1 - recede, transform: `translate(-50%, -50%) scale(${interp(f, 0, 30, 0.9, 1)})` }}
      >
        <IconFrame>
          <KortixLogo variant="icon" />
        </IconFrame>
      </div>

      {f < 200 ? (
        <div className="absolute inset-x-0 bottom-14 text-center" style={{ opacity: first.opacity, filter: first.filter }}>
          <Headline lead="3,000+ apps." rest="Any MCP or API." f={f} at={110} size="text-5xl" />
        </div>
      ) : null}

      {f >= 184 ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-10">
          <div className="flex gap-4">
            {MODELS.map((m, i) => (
              <div
                key={m}
                className="border-border bg-popover grid size-20 place-items-center rounded-2xl border"
                style={rise(f, 200 + stagger(i, 5), { dist: 24, scale: 0.9 })}
              >
                <span
                  className="bg-foreground size-9"
                  style={{
                    mask: `url(/provider-icons/${m}.svg) center / contain no-repeat`,
                    WebkitMask: `url(/provider-icons/${m}.svg) center / contain no-repeat`,
                  }}
                />
              </div>
            ))}
          </div>
          <div className="text-center">
            <Headline lead="Any model." rest="Your keys." f={f} at={196} />
            <p className="text-muted-foreground mt-5 text-xl" style={rise(f, 236)}>
              Or the ChatGPT subscription you already pay for.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ── Beat 8 · where your team already works ─────────────────────────────── */

const SURFACES = [
  { id: 'web', label: 'Web', icon: MonitorIcon, at: 0 },
  { id: 'slack', label: 'Slack', icon: Slack, at: 120 },
  { id: 'cli', label: 'CLI', icon: TerminalWindowIcon, at: 240 },
] as const;

function SlackThread({ f }: { f: number }) {
  return (
    <div className="space-y-5 px-6 py-6">
      <div className="flex items-start gap-3" style={rise(f, 132)}>
        <span className="bg-muted text-foreground grid size-9 shrink-0 place-items-center rounded-md text-sm font-medium">
          O
        </span>
        <div>
          <p className="text-foreground text-sm font-medium">Ops lead</p>
          <p className="text-muted-foreground text-base">
            <span className="text-foreground">@Kortix</span> find last week&apos;s failed payments and draft
            the customer emails
          </p>
        </div>
      </div>
      <div className="flex items-start gap-3" style={rise(f, 160)}>
        <span className="size-9 shrink-0">
          <IconFrame>
            <KortixLogo variant="icon" />
          </IconFrame>
        </span>
        <div className="space-y-1">
          <p className="text-foreground flex items-center gap-2 text-sm font-medium">
            Kortix <Badge variant="muted" size="xs">app</Badge>
          </p>
          <p className="text-muted-foreground text-base">On it — started a session on its own computer.</p>
          <p className="text-muted-foreground text-base" style={rise(f, 196)}>
            Done. The drafts are in a change request for you to approve.
          </p>
        </div>
      </div>
    </div>
  );
}

export function Surfaces() {
  const f = useFrame();
  const active = f >= 240 ? 2 : f >= 120 ? 1 : 0;

  return (
    <div className="absolute inset-0 flex flex-col items-center px-20 pt-12">
      <Headline lead="Where your team" rest="already works." f={f} at={-6} size="text-5xl" />

      <div className="mt-6 flex gap-1" style={rise(f, 20)}>
        {SURFACES.map((s, i) => {
          const Icon = s.icon;
          return (
            <span
              key={s.id}
              className={cn(
                'flex items-center gap-2 rounded-full px-3 py-1.5 text-sm',
                i === active ? 'bg-muted text-foreground' : 'text-muted-foreground',
              )}
            >
              <Icon className="size-4" /> {s.label}
            </span>
          );
        })}
      </div>

      <div className="relative mt-6 w-3xl flex-1" style={{ perspective: 1800 }}>
        {SURFACES.map((s, i) => {
          const end = SURFACES[i + 1]?.at ?? 999;
          if (f < s.at - 12 || f >= end + 14) return null;
          const look = span(f, s.at, end, { dist: 30, blur: 8, scale: 0.97 });
          return (
            <div
              key={s.id}
              className="absolute inset-x-0 top-0"
              style={{ ...look, transform: `${look.transform} rotateX(${interp(f, s.at, s.at + 120, 8, 2, ease.outCubic)}deg)` }}
            >
              <Window title={s.id === 'slack' ? '# ops' : s.id === 'cli' ? '~/code' : 'kortix.com'}>
                {s.id === 'web' ? (
                  <Footage
                    src="/media/showcase/kortix-showcase-dark-1920.mp4"
                    start={11.6}
                    className="block aspect-[16/10] w-full"
                  />
                ) : s.id === 'cli' ? (
                  <Footage
                    src="/media/cli/kortix-cli-dark-1920.mp4"
                    start={16.7}
                    className="block aspect-[1920/806] w-full"
                  />
                ) : (
                  <SlackThread f={f} />
                )}
              </Window>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Beat 9 · it improves itself ────────────────────────────────────────── */

const CHAIN = [
  { at: 40, icon: ClockIcon, title: '03:00 · cron', meta: '0 0 3 * * *' },
  { at: 70, icon: null, title: 'Session started', meta: 'harness-reflector' },
  { at: 100, icon: GitPullRequestIcon, title: 'Change request', meta: 'harness: sharpen reconcile-invoices' },
] as const;

export function Triggers() {
  const f = useFrame();
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-14 px-20">
      <div className="text-center">
        <Headline lead="Triggers fire at night." rest="It improves itself." f={f} at={-6} size="text-5xl" />
      </div>
      <div className="flex items-center">
        {CHAIN.map((node, i) => {
          const Icon = node.icon;
          return (
            <div key={node.title} className="flex items-center">
              {i > 0 ? (
                <span
                  className="bg-border h-px w-14 origin-left"
                  style={{ transform: `scaleX(${interp(f, node.at - 16, node.at, 0, 1, ease.outCubic)})` }}
                />
              ) : null}
              <div
                className="border-border bg-popover flex items-center gap-3 rounded-2xl border px-4 py-3"
                style={rise(f, node.at, { dist: 16, scale: 0.95 })}
              >
                <span className="bg-muted text-foreground grid size-9 place-items-center rounded-md">
                  {Icon ? <Icon className="size-4" /> : <KortixLogo variant="icon" size={16} />}
                </span>
                <span className="space-y-0.5">
                  <span className="text-foreground block text-sm font-medium">{node.title}</span>
                  <span className="text-muted-foreground block font-mono text-xs">{node.meta}</span>
                </span>
                {i === 2 ? (
                  <span style={rise(f, 140, { dist: 0, scale: 0.9, blur: 6 })}>
                    <Badge variant="outline" size="xs">awaiting approval</Badge>
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Beat 10 · open source, run it anywhere ─────────────────────────────── */

const TERMINAL: { at: number; cmd?: string; out?: string }[] = [
  { at: 30, cmd: 'kortix init northwind' },
  { at: 76, out: '+ kortix.yaml' },
  { at: 82, out: '+ agents/kortix.md' },
  { at: 88, out: '+ memory/MEMORY.md' },
  { at: 104, cmd: 'cd northwind && kortix ship' },
  { at: 156, out: '✓ kortix.yaml verified' },
  { at: 170, out: '✓ Pushed main → origin/main' },
  { at: 184, out: '✓ Shipped Northwind' },
];

const RUNS = [
  { icon: CloudIcon, label: 'Kortix Cloud' },
  { icon: HardDrivesIcon, label: 'Your servers' },
  { icon: BuildingsIcon, label: 'On-prem' },
];

export function OpenSource() {
  const f = useFrame();
  const stars = Math.round(interp(f, 300, 380, 0, 20000, ease.outCubic) / 100) * 100;

  return (
    <div className="absolute inset-0 flex items-center gap-14 px-20">
      <div className="flex-1 space-y-8">
        <Headline lead="Open source." rest="Yours down to the metal." f={f} at={-6} size="text-5xl" stack />
        <Window title="~/code" style={rise(f, 20, { dist: 30, scale: 0.97 })}>
          <div className="min-h-64 space-y-1 px-5 py-4 font-mono text-sm">
            {TERMINAL.filter((l) => f >= l.at).map((l) =>
              l.cmd ? (
                <p key={l.at} className="text-foreground pt-1">
                  <span className="text-muted-foreground">~/code $ </span>
                  {typed(l.cmd, f, l.at, 0.7)}
                </p>
              ) : (
                <p key={l.at} className="text-muted-foreground pl-4">
                  {l.out}
                </p>
              ),
            )}
          </div>
        </Window>
      </div>

      <div className="w-80 space-y-3">
        {RUNS.map((r, i) => {
          const Icon = r.icon;
          return (
            <div
              key={r.label}
              className="border-border bg-popover flex items-center gap-3 rounded-2xl border px-4 py-3"
              style={rise(f, 210 + i * 30, { dist: 16 })}
            >
              <Icon className="text-foreground size-5" />
              <span className="text-foreground text-base">{r.label}</span>
            </div>
          );
        })}
        <div className="flex items-center gap-3 px-4 pt-5" style={rise(f, 300)}>
          <Github className="text-foreground size-7" />
          <span className="text-foreground text-4xl font-medium tracking-tight tabular-nums">
            {stars.toLocaleString('en-US')}
            {f >= 380 ? '+' : ''}
          </span>
          <span className="text-muted-foreground text-base">GitHub stars</span>
        </div>
      </div>
    </div>
  );
}

/* ── Beat 11 · the end card ─────────────────────────────────────────────── */

export function EndCard() {
  const f = useFrame();
  const out = interp(f, 300, 350, 1, 0, ease.outQuad);
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-6" style={{ opacity: out }}>
      <div style={rise(f, 0, { dist: 0, scale: 0.94, blur: 10 })}>
        <KortixLogo variant="brandmark" size={64} className="text-foreground" />
      </div>
      <p className="text-muted-foreground text-2xl" style={rise(f, 24)}>
        The open-source AI Operating System
      </p>
      <p className="text-foreground font-mono text-lg" style={rise(f, 48)}>
        kortix.com
      </p>
    </div>
  );
}
