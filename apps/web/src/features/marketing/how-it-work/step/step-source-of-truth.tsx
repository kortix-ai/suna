'use client';

import { useLocalizedUiCatalog } from '@kortix/ui/i18n';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@kortix/ui';
import {
  BookOpenIcon,
  CpuIcon,
  LightningIcon,
  PlugIcon,
  RobotIcon,
  ShieldIcon,
  SparkleIcon,
} from '@phosphor-icons/react';
import { m, useInView, useReducedMotion, type Transition } from 'motion/react';
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';

/**
 * Layer 01 — the repo IS the company, drawn as a dock (Paper "Kortix 2",
 * source of truth v2, Q25).
 *
 * Seven tiles in one dock: the three folders, a hairline, then the four
 * blocks of `kortix.yaml`. One tile is "lifted" at a time and named in a
 * tooltip; the dock walks through them on its own so a visitor who never
 * hovers still reads every part. Hover takes over and pauses the walk.
 *
 * ACCURACY GATE — every tile is something that verifiably lives in the repo:
 *   - `agents/`, `skills/` and `memory/` are folders at the repo root.
 *   - Rules, Triggers, Connectors and Machine are declared in `kortix.yaml`.
 *   - No Channels tile (`channels:` is rejected in version 2) and no Members
 *     tile (members are live project state, not files).
 * `acme-co` is a placeholder, not a customer.
 *
 * MOTION. Only `transform` and `opacity` move. The lift is a scale from the
 * tile's bottom edge (44 → 56px on the board), never a width change, so the
 * dock never reflows. Entry plays once when the panel scrolls in; the walk
 * runs only while the panel is on screen. Reduced motion keeps the fades and
 * the tooltip, drops the lift and the stagger, and does not walk.
 */

type TileId = 'agents' | 'skills' | 'memory' | 'rules' | 'triggers' | 'connectors' | 'machine';

const TILES: {
  id: TileId;
  icon: ComponentType<{ className?: string }>;
  label: string;
}[] = [
  { id: 'agents', icon: RobotIcon, label: 'Agents' },
  { id: 'skills', icon: SparkleIcon, label: 'Skills' },
  { id: 'memory', icon: BookOpenIcon, label: 'Memory' },
  { id: 'rules', icon: ShieldIcon, label: 'Rules' },
  { id: 'triggers', icon: LightningIcon, label: 'Triggers' },
  { id: 'connectors', icon: PlugIcon, label: 'Connectors' },
  { id: 'machine', icon: CpuIcon, label: 'Machine' },
];

const COPY = { title: 'Your whole company, in one repo' };

/** The hairline sits after the folders: everything right of it is `kortix.yaml`. */
const FOLDER_COUNT = 3;
/** The board opens on Skills. */
const START = 1;
/** Long enough to read a word, short enough to reach all seven in ~15s. */
const WALK_MS = 2200;
/** 56 / 44 — the lifted tile on the board. */
const LIFT = 56 / 44;

const EASE_OUT: Transition['ease'] = [0.22, 1, 0.36, 1];
const ENTER: Transition = { duration: 0.3, ease: EASE_OUT };
const MOVE: Transition = { duration: 0.16, ease: EASE_OUT };
const FADE: Transition = { duration: 0.12, ease: EASE_OUT };

export function StepSourceOfTruth(): ReactNode {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tiles = useLocalizedUiCatalog(TILES);
  const copy = useLocalizedUiCatalog(COPY);
  const reduced = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const entered = useInView(rootRef, { once: true, amount: 0.35 });
  const onScreen = useInView(rootRef);
  const [active, setActive] = useState(START);
  const [hovering, setHovering] = useState(false);

  useEffect(() => {
    if (reduced || hovering || !onScreen || !entered) return;
    const id = window.setInterval(() => setActive((i) => (i + 1) % TILES.length), WALK_MS);
    return () => window.clearInterval(id);
  }, [reduced, hovering, onScreen, entered]);

  return (
    <div
      ref={rootRef}
      className="bg-card flex h-full min-h-0 w-full flex-col items-center justify-center gap-6 overflow-hidden p-4"
    >
      <m.ul
        aria-label={tI18nComplete.raw('text7918c1b7fe03')}
        initial={{ opacity: 0, y: reduced ? 0 : 8 }}
        animate={entered ? { opacity: 1, y: 0 } : undefined}
        transition={ENTER}
        onMouseLeave={() => setHovering(false)}
        className="border-border bg-background mt-12 flex items-end gap-1.5 rounded-2xl border p-2 sm:gap-2 sm:p-2.5"
      >
        {tiles.map((tile, i) => {
          const Icon = tile.icon;
          const lifted = i === active;
          return (
            <li key={tile.id} className="flex items-end gap-1.5 sm:gap-2">
              {i === FOLDER_COUNT && <span aria-hidden className="bg-border h-9 w-px self-center" />}
              <m.div
                initial={{ opacity: 0, scale: reduced ? 1 : 0.95 }}
                animate={
                  entered
                    ? { opacity: 1, scale: lifted && !reduced ? LIFT : 1 }
                    : undefined
                }
                transition={{ ...MOVE, opacity: { ...ENTER, delay: reduced ? 0 : i * 0.04 } }}
                onMouseEnter={() => {
                  setHovering(true);
                  setActive(i);
                }}
                style={{ transformOrigin: 'bottom center' }}
                className="bg-card text-foreground relative flex size-10 items-center justify-center rounded-xl sm:size-12"
              >
                <Icon className="size-4 sm:size-4.5" />
                <span className="sr-only">{tile.label}</span>
                {/* Tooltip — counter-scaled so the label never grows with the tile. */}
                <m.span
                  aria-hidden
                  initial={false}
                  animate={{
                    opacity: lifted ? 1 : 0,
                    y: lifted || reduced ? 0 : 4,
                    scale: lifted && !reduced ? 1 / LIFT : 1,
                  }}
                  transition={{ ...MOVE, opacity: FADE }}
                  style={{ transformOrigin: 'bottom center' }}
                  className="bg-foreground text-background pointer-events-none absolute bottom-full mb-2 rounded-md px-2.5 py-1.5 text-xs leading-4 whitespace-nowrap"
                >
                  {tile.label}
                </m.span>
              </m.div>
            </li>
          );
        })}
      </m.ul>

      <m.div
        initial={{ opacity: 0 }}
        animate={entered ? { opacity: 1 } : undefined}
        transition={{ ...ENTER, delay: reduced ? 0 : 0.2 }}
        className="flex flex-col items-center gap-1 text-center"
      >
        <p className="text-foreground text-lg leading-snug font-medium text-balance">
          {copy.title}
        </p>
        <p className="text-muted-foreground font-mono text-xs">{tI18nComplete.raw('text7918c1b7fe03')}</p>
      </m.div>
    </div>
  );
}
