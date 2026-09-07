import {
  BugIcon,
  ChartLineIcon,
  ChatCircleIcon,
  CurrencyDollarIcon,
  DatabaseIcon,
  EnvelopeIcon,
  HeadsetIcon,
  type IconProps,
  MagnifyingGlassIcon,
  MegaphoneIcon,
  NotepadIcon,
  PuzzlePieceIcon,
  ShieldCheckIcon,
  UsersIcon,
} from '@phosphor-icons/react';
import type { ComponentType } from 'react';

/**
 * A template's tile, DERIVED from its slug rather than stored.
 *
 * The mock carried `icon` / `color` / `bgColor` on every template. Two reasons
 * they are gone:
 *
 *  1. The API cannot supply them. A template is a GitHub repo;
 *     nothing in a `kortix.yaml` names a Phosphor component, and inventing a
 *     field for one would make every template author pick a React import.
 *  2. Holding icon VALUES pinned the whole data module to the client graph —
 *     `@phosphor-icons/react` calls `createContext` at module scope, so a
 *     server component importing the catalogue crashed the build. Keeping the
 *     icons here, and only here, is what lets `templates-catalog.ts` be read from
 *     anywhere.
 *
 * Deterministic by slug, so one template looks the same on the store card and the
 * install modal — the same guarantee (and the same hash
 * shape) `projectBannerClass` already gives a project.
 */

/** Icon + tone + fill, all `kortix-*` tokens. Never a raw palette class. */
export interface TemplateVisual {
  Icon: ComponentType<IconProps>;
  /** Icon tone, e.g. `text-kortix-blue`. */
  color: string;
  /** Tile fill behind the icon, e.g. `bg-kortix-blue/15`. */
  bgColor: string;
  /**
   * The card/detail banner wash, e.g. `from-kortix-blue/30 via-kortix-blue/5`.
   *
   * It rides on the SAME hue index as `color`/`bgColor` above, so a template's
   * banner, its tile and its icon can never disagree — one template, one hue,
   * everywhere it appears.
   *
   * This is the one gradient in the feature, and it is identity rather than
   * decoration: it is how a person tells one card from another at a glance in a
   * grid where every card has the same shape. Both stops are `kortix-*` tokens,
   * so it flips with the theme like every other colour here.
   */
  banner: string;
}

/**
 * The five hues carried over from the prototype's category tiles — Engineering
 * blue, Security red, Growth orange, Finance green, Support purple — paired
 * with an icon each. Kept to five so a store grid never looks like a paint
 * chart.
 */
const VISUALS: readonly TemplateVisual[] = [
  {
    Icon: BugIcon,
    color: 'text-kortix-blue',
    bgColor: 'bg-kortix-blue/15',
    banner: 'from-kortix-blue/30 via-kortix-blue/5',
  },
  {
    Icon: ShieldCheckIcon,
    color: 'text-kortix-red',
    bgColor: 'bg-kortix-red/15',
    banner: 'from-kortix-red/30 via-kortix-red/5',
  },
  {
    Icon: ChartLineIcon,
    color: 'text-kortix-orange',
    bgColor: 'bg-kortix-orange/15',
    banner: 'from-kortix-orange/30 via-kortix-orange/5',
  },
  {
    Icon: CurrencyDollarIcon,
    color: 'text-kortix-green',
    bgColor: 'bg-kortix-green/15',
    banner: 'from-kortix-green/30 via-kortix-green/5',
  },
  {
    Icon: HeadsetIcon,
    color: 'text-kortix-purple',
    bgColor: 'bg-kortix-purple/15',
    banner: 'from-kortix-purple/30 via-kortix-purple/5',
  },
];

/**
 * Slugs whose meaning is obvious enough to earn a specific icon. A template named
 * for what it does should look like what it does; everything else falls back to
 * the deterministic pick, which is stable but arbitrary.
 */
const BY_KEYWORD: ReadonlyArray<readonly [RegExp, ComponentType<IconProps>]> = [
  // FIRST MATCH WINS, so the specific subjects come before the broad ones.
  // `feedback-triage` is feedback, not an incident, and it would otherwise be
  // claimed by `/triage/` below.
  [/candidate|hiring|recruit|resume|screening|interview/, UsersIcon],
  [/query|database|sql|postgres|schema|index/, DatabaseIcon],
  [/feedback|survey|nps|sentiment|review/, ChatCircleIcon],
  [/\bads?\b|campaign|creative|a-?b-?test/, MegaphoneIcon],
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

/** The tile for one template. Stable for a given slug, forever. */
export function templateVisual(slug: string): TemplateVisual {
  const seed = slug.toLowerCase();
  const base = VISUALS[hashOf(seed) % VISUALS.length];
  const keyword = BY_KEYWORD.find(([pattern]) => pattern.test(seed));
  // The hue stays deterministic even when a keyword picks the glyph, so two
  // templates that both match `/report/` still read as different cards.
  return keyword ? { ...base, Icon: keyword[1] } : base;
}
