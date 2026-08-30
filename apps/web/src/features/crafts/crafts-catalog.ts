import {
  BugIcon,
  ChartLineIcon,
  CurrencyDollarIcon,
  EnvelopeIcon,
  HeadsetIcon,
  MagnifyingGlassIcon,
  NotepadIcon,
  PuzzlePieceIcon,
  ShieldCheckIcon,
  type IconProps,
} from '@phosphor-icons/react';
import type { ComponentType } from 'react';

import type { CraftConnector } from './connectors-catalog';

/**
 * The Crafts catalog — STATIC MOCK DATA for the UI/UX phase.
 *
 * Nothing here is fetched: no SDK call, no registry read, no API. A later
 * phase swaps this module for the real catalog, keeping the component tree
 * untouched — the shape below is cut so that swap is a data change, not a
 * component change. Repos and star counts are MOCKED alongside installs.
 *
 * Client-graph only: this module imports icon VALUES from the main
 * `@phosphor-icons/react` entry, which calls `createContext` at module scope.
 * Importing it from a server component crashes the build — see
 * `.claude/skills/kortix-design-system/SKILL.md` → Icons.
 */
export interface Craft {
  id: string;
  title: string;
  /** One-liner under the title. Same string on cards, in the modal, everywhere. */
  description: string;
  /** A Phosphor icon component — tiles render it with `weight="fill"`. */
  icon: ComponentType<IconProps>;
  /** Icon tone inside the tile, e.g. `text-kortix-blue`. Literal Tailwind class. */
  color: string;
  /** Tile fill behind the icon, e.g. `bg-kortix-blue/15`. Literal Tailwind class. */
  bgColor: string;
  /** GitHub source. Cards render `owner/repo` with the star count; the modal links out. */
  repo: { owner: string; repo: string; stars: number };
  /** Social proof, MOCKED. The registry carries no install counts yet. */
  installs: number;
  /**
   * The third-party apps this craft plugs into, in the order it touches them:
   * what it reads first, what it writes last. Ids key into `CONNECTORS`.
   *
   * This is the craft's REQUIREMENT list, not the viewer's connection state —
   * see the header note in `connectors-catalog.ts`. Keep it to 2-4 entries;
   * a longer list stops being a decision aid and becomes a wall.
   */
  connectors: CraftConnector[];
  /**
   * MOCK for the UI phase: the craft is already installed into this project.
   * The real flow reads installed state from the API. Installed cards render a
   * green status pill and a disabled modal button instead of the install affordance.
   */
  installed?: boolean;
}

/**
 * Per-craft color law. `kortix-*` tokens only — no raw palette. The five hues
 * carry over from the prototype's category tiles: Engineering blue, Security
 * red, Growth orange, Finance green, Support purple.
 */
export const CRAFTS: Craft[] = [
  {
    id: 'error-triage',
    title: 'Error Triage',
    description:
      'Reads every new error in Sentry, Datadog and New Relic. Groups by root cause, opens a GitHub issue per cause, opens a PR when the fix is small and safe.',
    icon: BugIcon,
    color: 'text-kortix-blue',
    bgColor: 'bg-kortix-blue/15',
    repo: { owner: 'kortix-ai', repo: 'error-triage', stars: 2431 },
    installs: 4218,
    connectors: [
      { id: 'sentry', role: 'Reads new errors' },
      { id: 'datadog', role: 'Reads error logs' },
      { id: 'newrelic', role: 'Reads traces' },
      { id: 'github', role: 'Opens issues and PRs' },
    ],
  },
  {
    id: 'standup',
    title: 'Standup Scribe',
    description: 'A three-line standup in Slack every weekday: shipped, shipping, blocked.',
    icon: NotepadIcon,
    color: 'text-kortix-blue',
    bgColor: 'bg-kortix-blue/15',
    repo: { owner: 'kortix-ai', repo: 'standup-scribe', stars: 1876 },
    installs: 5112,
    installed: true,
    connectors: [
      { id: 'linear', role: 'Reads issue moves' },
      { id: 'github', role: 'Reads merged PRs' },
      { id: 'slack', role: 'Posts the standup' },
    ],
  },
  {
    id: 'seo',
    title: 'SEO Tune-up',
    description: 'Reads Search Console weekly, fixes what is slipping, PRs the changes.',
    icon: MagnifyingGlassIcon,
    color: 'text-kortix-orange',
    bgColor: 'bg-kortix-orange/15',
    repo: { owner: 'kortix-ai', repo: 'seo-tuneup', stars: 1120 },
    installs: 3057,
    connectors: [
      { id: 'googlesearchconsole', role: 'Reads weekly queries' },
      { id: 'googleanalytics', role: 'Reads page traffic' },
      { id: 'github', role: 'PRs the fixes' },
    ],
  },
  {
    id: 'pentest',
    title: 'Daily Pentest',
    description: 'Attacks your own platform every morning, files a GitHub issue per finding.',
    icon: ShieldCheckIcon,
    color: 'text-kortix-red',
    bgColor: 'bg-kortix-red/15',
    repo: { owner: 'kortix-ai', repo: 'daily-pentest', stars: 3242 },
    installs: 1904,
    connectors: [
      { id: 'snyk', role: 'Reads known CVEs' },
      { id: 'github', role: 'Files a finding issue' },
      { id: 'slack', role: 'Posts the summary' },
    ],
  },
  {
    id: 'concierge',
    title: 'Welcome Concierge',
    description: 'Personal welcome email to every new signup, in your voice.',
    icon: EnvelopeIcon,
    color: 'text-kortix-orange',
    bgColor: 'bg-kortix-orange/15',
    repo: { owner: 'kortix-ai', repo: 'welcome-concierge', stars: 1544 },
    installs: 2733,
    installed: true,
    connectors: [
      { id: 'stripe', role: 'Reads new customers' },
      { id: 'resend', role: 'Sends the welcome' },
      { id: 'hubspot', role: 'Writes the contact' },
    ],
  },
  {
    id: 'invoices',
    title: 'Invoice Chaser',
    description: 'Chases overdue invoices with escalating, polite reminders.',
    icon: CurrencyDollarIcon,
    color: 'text-kortix-green',
    bgColor: 'bg-kortix-green/15',
    repo: { owner: 'kortix-ai', repo: 'invoice-chaser', stars: 892 },
    installs: 1488,
    connectors: [
      { id: 'stripe', role: 'Reads overdue invoices' },
      { id: 'quickbooks', role: 'Reads the ledger' },
      { id: 'gmail', role: 'Sends the reminders' },
    ],
  },
  {
    id: 'support',
    title: 'Support Triage',
    description: 'Tags and drafts replies for every new support conversation.',
    icon: HeadsetIcon,
    color: 'text-kortix-purple',
    bgColor: 'bg-kortix-purple/15',
    repo: { owner: 'kortix-ai', repo: 'support-triage', stars: 2210 },
    installs: 2240,
    connectors: [
      { id: 'intercom', role: 'Reads conversations' },
      { id: 'zendesk', role: 'Reads tickets' },
      { id: 'linear', role: 'Files bug issues' },
      { id: 'slack', role: 'Escalates blockers' },
    ],
  },
  {
    id: 'competitors',
    title: 'Competitor Watch',
    description: 'Watches competitor changelogs and pricing. Weekly brief in Slack.',
    icon: ChartLineIcon,
    color: 'text-kortix-orange',
    bgColor: 'bg-kortix-orange/15',
    repo: { owner: 'kortix-ai', repo: 'competitor-watch', stars: 745 },
    installs: 1371,
    connectors: [
      { id: 'notion', role: 'Writes the brief' },
      { id: 'slack', role: 'Posts it weekly' },
    ],
  },
  {
    id: 'deps',
    title: 'Dependency Watch',
    description: 'One tidy upgrade PR a week, tested before you see it.',
    icon: PuzzlePieceIcon,
    color: 'text-kortix-blue',
    bgColor: 'bg-kortix-blue/15',
    repo: { owner: 'kortix-ai', repo: 'dependency-watch', stars: 1963 },
    installs: 986,
    connectors: [
      { id: 'github', role: 'Opens the upgrade PR' },
      { id: 'slack', role: 'Posts the digest' },
    ],
  },
];

/** `owner/repo` for meta rows and search. */
export const craftRepoSlug = (craft: Craft): string => `${craft.repo.owner}/${craft.repo.repo}`;

/** Link out target for the modal's repo row. */
export const craftRepoUrl = (craft: Craft): string =>
  `https://github.com/${craft.repo.owner}/${craft.repo.repo}`;

/** Compact count for card meta — `2431` renders `2.4k`, `986` stays `986`. */
export const formatCount = (n: number): string =>
  new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
