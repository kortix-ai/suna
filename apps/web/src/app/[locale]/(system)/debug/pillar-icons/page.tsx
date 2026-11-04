'use client';

/**
 * /debug/pillar-icons — PROTOTYPE. Hover a landing pillar card: its icon fills
 * with a live, multi-colour dithered gradient that leans toward the cursor.
 * Each pillar has its own colour ramp and motion: ripples (Multiplayer), a
 * caret sweep (Company as code), a rising fill (Sovereign), a stroke wipe
 * (fact checks). `surface` switches between colour inside the strokes
 * (glyph) and a colour tile behind a knocked-out glyph (tile).
 * Theme: the /debug toggle, or press `D`.
 */

import { useRef, useState, type ReactNode } from 'react';

import {
  DitherIcon,
  type DitherMode,
  type DitherSurface,
} from '@/features/marketing/landing-sections/dither-icon.prototype';
import type { Icon as PhosphorIcon, IconWeight } from '@phosphor-icons/react';
import { CheckIcon, CodeIcon, ShieldCheckIcon, UsersThreeIcon } from '@phosphor-icons/react/dist/ssr';

type Ramp = [string, string, string, string];

// One ramp per pillar, ordered by hue so neighbouring dither stops sit close.
const PER_PILLAR: Record<DitherMode, Ramp> = {
  users: ['--kortix-red', '--kortix-purple', '--kortix-blue', '--ring'],
  code: ['--kortix-green', '--ring', '--kortix-blue', '--kortix-purple'],
  shield: ['--kortix-orange', '--kortix-red', '--kortix-purple', '--kortix-blue'],
  check: ['--kortix-green', '--kortix-yellow', '--kortix-orange', '--kortix-red'],
};
const SPECTRUM: Ramp = ['--kortix-purple', '--ring', '--kortix-green', '--kortix-orange'];
const SUNSET: Ramp = ['--kortix-purple', '--kortix-red', '--kortix-orange', '--kortix-yellow'];
const RAMPS = {
  'per pillar': (m: DitherMode) => PER_PILLAR[m],
  spectrum: () => SPECTRUM,
  sunset: () => SUNSET,
} as const;
type RampName = keyof typeof RAMPS;

const PILLARS: { mode: DitherMode; icon: PhosphorIcon; name: string; line: string; body: string; facts: string[] }[] = [
  {
    mode: 'users',
    icon: UsersThreeIcon,
    name: 'Multiplayer AI',
    line: 'One AI for the whole team.',
    body: 'Everyone works with the same agents, skills, memory and connectors. Start a session in the web app, in Slack or in Microsoft Teams.',
    facts: ['Shared agents, skills and memory', 'Slack and Microsoft Teams'],
  },
  {
    mode: 'code',
    icon: CodeIcon,
    name: 'Company as code',
    line: 'Extensible to the core.',
    body: 'Every agent, skill, rule, connector and piece of context is a file in one git repo.',
    facts: ['Every agent and skill a file in git', 'An open-source agent harness'],
  },
  {
    mode: 'shield',
    icon: ShieldCheckIcon,
    name: 'Sovereign and open',
    line: 'Own your data and your infrastructure.',
    body: 'Kortix is open source. Run it on Kortix Cloud, in your VPC or on your own on-prem network.',
    facts: ['Open source: read it, fork it, audit it', 'Self-host in your VPC or on-prem'],
  },
];

type Settings = {
  surface: DitherSurface;
  size: number;
  activeWeight: IconWeight;
  pixel: number;
  speed: number;
  ramp: RampName;
  force: boolean;
  checks: boolean;
};

function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground text-xs">{label}</span>
      <div className="bg-muted flex gap-px rounded-md p-0.5">
        {options.map((o) => (
          <button
            key={String(o)}
            type="button"
            onClick={() => onChange(o)}
            className={
              'rounded-sm px-2 py-1 text-xs transition-colors ' +
              (o === value ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground')
            }
          >
            {String(o)}
          </button>
        ))}
      </div>
    </div>
  );
}

function Card({ pillar, s }: { pillar: (typeof PILLARS)[number]; s: Settings }) {
  const [hover, setHover] = useState(false);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const active = hover || s.force;
  const tileSize = s.size * 2;
  return (
    <li
      tabIndex={0}
      onPointerEnter={(e) => e.pointerType === 'mouse' && setHover(true)}
      onPointerMove={(e) => {
        if (e.pointerType === 'mouse') pointer.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerLeave={() => {
        pointer.current = null;
        setHover(false);
      }}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      className="bg-background flex flex-col gap-5 p-6 outline-none lg:p-11"
    >
      <DitherIcon
        icon={pillar.icon}
        mode={pillar.mode}
        active={active}
        pointer={pointer}
        palette={RAMPS[s.ramp](pillar.mode)}
        surface={s.surface}
        size={s.surface === 'tile' ? tileSize : s.size}
        activeWeight={s.activeWeight}
        pixel={s.pixel}
        speed={s.speed}
      />
      <h3 className="text-foreground text-2xl font-medium tracking-tight text-balance">
        {pillar.name}
        <span className="text-muted-foreground block text-lg">{pillar.line}</span>
      </h3>
      <p className="text-muted-foreground text-base text-pretty">{pillar.body}</p>
      <ul className="mt-auto flex flex-col gap-2 text-sm">
        {pillar.facts.map((fact) => (
          <li key={fact} className="text-foreground flex items-start gap-2">
            {s.checks ? (
              <span className="mt-0.5 flex">
                <DitherIcon
                  icon={CheckIcon}
                  mode="check"
                  active={active}
                  pointer={pointer}
                  palette={RAMPS[s.ramp](pillar.mode)}
                  size={16}
                  activeWeight="bold"
                  pixel={s.pixel}
                  speed={s.speed}
                />
              </span>
            ) : (
              <CheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
            )}
            {fact}
          </li>
        ))}
      </ul>
    </li>
  );
}

function Specimen({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="bg-background flex flex-col items-center gap-3 p-6">
      {children}
      <span className="text-muted-foreground text-xs">{label}</span>
    </div>
  );
}

export default function PillarIconsDebugPage() {
  const [s, setS] = useState<Settings>({
    surface: 'glyph',
    size: 32,
    activeWeight: 'fill',
    pixel: 2,
    speed: 1,
    ramp: 'per pillar',
    force: false,
    checks: true,
  });
  const set = <K extends keyof Settings>(k: K) => (v: Settings[K]) => setS((p) => ({ ...p, [k]: v }));
  const specimenPointer = useRef<{ x: number; y: number } | null>(null);

  return (
    <main className="bg-background min-h-dvh pb-48">
      <div className="mx-auto max-w-6xl px-4 pt-12">
        <h1 className="text-foreground text-xl font-medium">Pillar icons: live dithered colour</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Prototype. Hover a card and move the cursor around it. At rest each icon is the plain Phosphor glyph.
        </p>

        <ul className="bg-border mt-10 grid grid-cols-1 gap-px border lg:grid-cols-3">
          {PILLARS.map((p) => (
            <Card key={p.mode} pillar={p} s={s} />
          ))}
        </ul>

        <h2 className="text-foreground mt-16 text-sm font-medium">Specimens at 120px, always on, follow the cursor</h2>
        <div
          className="bg-border mt-4 grid grid-cols-2 gap-px border lg:grid-cols-4"
          onPointerMove={(e) => {
            specimenPointer.current = { x: e.clientX, y: e.clientY };
          }}
          onPointerLeave={() => {
            specimenPointer.current = null;
          }}
        >
          {[...PILLARS.map((p) => ({ mode: p.mode, icon: p.icon })), { mode: 'check' as const, icon: CheckIcon }].map((p) => (
            <Specimen key={p.mode} label={p.mode}>
              <DitherIcon
                icon={p.icon}
                mode={p.mode}
                active
                pointer={specimenPointer}
                palette={RAMPS[s.ramp](p.mode)}
                surface={s.surface}
                size={120}
                activeWeight={s.activeWeight}
                pixel={s.pixel * 2}
                speed={s.speed}
              />
            </Specimen>
          ))}
        </div>
      </div>

      <div className="bg-popover text-popover-foreground fixed bottom-4 left-1/2 z-50 flex w-[min(100%-2rem,64rem)] -translate-x-1/2 flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border p-3 shadow-lg">
        <Segmented label="surface" value={s.surface} options={['glyph', 'tile'] as const} onChange={set('surface')} />
        <Segmented label="ramp" value={s.ramp} options={Object.keys(RAMPS) as RampName[]} onChange={set('ramp')} />
        <Segmented label="size" value={s.size} options={[24, 32, 40] as const} onChange={set('size')} />
        <Segmented label="lit weight" value={s.activeWeight} options={['regular', 'bold', 'fill', 'duotone'] as const} onChange={set('activeWeight')} />
        <Segmented label="cell" value={s.pixel} options={[1, 2, 3] as const} onChange={set('pixel')} />
        <Segmented label="speed" value={s.speed} options={[0.5, 1, 2] as const} onChange={set('speed')} />
        <Segmented label="hover" value={s.force ? 'forced' : 'pointer'} options={['pointer', 'forced'] as const} onChange={(v) => set('force')(v === 'forced')} />
        <Segmented label="checks" value={s.checks ? 'on' : 'off'} options={['on', 'off'] as const} onChange={(v) => set('checks')(v === 'on')} />
      </div>
    </main>
  );
}
