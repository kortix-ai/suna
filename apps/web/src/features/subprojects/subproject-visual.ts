import {
  BugIcon,
  ChartLineIcon,
  CurrencyDollarIcon,
  EnvelopeIcon,
  HeadsetIcon,
  type IconProps,
  MagnifyingGlassIcon,
  NotepadIcon,
  PuzzlePieceIcon,
  ShieldCheckIcon,
} from '@phosphor-icons/react';
import type { ComponentType } from 'react';

/**
 * A subproject's tile, DERIVED from its slug rather than stored.
 *
 * The mock carried `icon` / `color` / `bgColor` on every subproject. Two reasons
 * they are gone:
 *
 *  1. The API cannot supply them. A subproject is a GitHub repo or an uploaded zip;
 *     nothing in a `kortix.yaml` names a Phosphor component, and inventing a
 *     field for one would make every subproject author pick a React import.
 *  2. Holding icon VALUES pinned the whole data module to the client graph —
 *     `@phosphor-icons/react` calls `createContext` at module scope, so a
 *     server component importing the catalogue crashed the build. Keeping the
 *     icons here, and only here, is what lets `subprojects-catalog.ts` be read from
 *     anywhere.
 *
 * Deterministic by slug, so one subproject looks the same on the store card, the
 * install modal and the run report — the same guarantee (and the same hash
 * shape) `projectBannerClass` already gives a marketplace project.
 */

/** Icon + tone + fill, all `kortix-*` tokens. Never a raw palette class. */
export interface SubprojectVisual {
  Icon: ComponentType<IconProps>;
  /** Icon tone, e.g. `text-kortix-blue`. */
  color: string;
  /** Tile fill behind the icon, e.g. `bg-kortix-blue/15`. */
  bgColor: string;
}

/**
 * The five hues carried over from the prototype's category tiles — Engineering
 * blue, Security red, Growth orange, Finance green, Support purple — paired
 * with an icon each. Kept to five so a store grid never looks like a paint
 * chart.
 */
const VISUALS: readonly SubprojectVisual[] = [
  { Icon: BugIcon, color: 'text-kortix-blue', bgColor: 'bg-kortix-blue/15' },
  { Icon: ShieldCheckIcon, color: 'text-kortix-red', bgColor: 'bg-kortix-red/15' },
  { Icon: ChartLineIcon, color: 'text-kortix-orange', bgColor: 'bg-kortix-orange/15' },
  { Icon: CurrencyDollarIcon, color: 'text-kortix-green', bgColor: 'bg-kortix-green/15' },
  { Icon: HeadsetIcon, color: 'text-kortix-purple', bgColor: 'bg-kortix-purple/15' },
];

/**
 * Slugs whose meaning is obvious enough to earn a specific icon. A subproject named
 * for what it does should look like what it does; everything else falls back to
 * the deterministic pick, which is stable but arbitrary.
 */
const BY_KEYWORD: ReadonlyArray<readonly [RegExp, ComponentType<IconProps>]> = [
  [/error|triage|bug|incident|on-?call/, BugIcon],
  [/security|pentest|audit|vuln/, ShieldCheckIcon],
  [/seo|growth|analytic|metric|report/, ChartLineIcon],
  [/invoice|billing|finance|payment|revenue/, CurrencyDollarIcon],
  [/support|help|ticket|concierge/, HeadsetIcon],
  [/standup|note|digest|summary|scribe/, NotepadIcon],
  [/outreach|email|mail|newsletter/, EnvelopeIcon],
  [/competitor|research|watch|monitor|search/, MagnifyingGlassIcon],
  [/dependency|deps|package|upgrade/, PuzzlePieceIcon],
];

function hashOf(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return h;
}

/** The tile for one subproject. Stable for a given slug, forever. */
export function subprojectVisual(slug: string): SubprojectVisual {
  const seed = slug.toLowerCase();
  const base = VISUALS[hashOf(seed) % VISUALS.length];
  const keyword = BY_KEYWORD.find(([pattern]) => pattern.test(seed));
  // The hue stays deterministic even when a keyword picks the glyph, so two
  // subprojects that both match `/report/` still read as different cards.
  return keyword ? { ...base, Icon: keyword[1] } : base;
}
