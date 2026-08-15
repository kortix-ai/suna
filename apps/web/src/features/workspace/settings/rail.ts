import {
  AlarmIcon as AlarmClock,
  BracketsCurlyIcon as ApiKeys,
  ArrowCircleUpIcon as ArrowUpCircle,
  WaveformIcon as AudioLines,
  CubeIcon as Boxes,
  ChatTeardropIcon,
  CoinsIcon as Coins,
  ShippingContainerIcon as Container,
  CreditCardIcon as CreditCard,
  FingerprintIcon as Fingerprint,
  FlaskIcon as Flask,
  GitForkIcon as GitFork,
  GlobeIcon as Globe,
  TrayIcon as Inbox,
  KeyIcon as KeyRound,
  LinkIcon as Link,
  NetworkIcon as Network,
  PlugsConnectedIcon as Plugs,
  RobotIcon as Robot,
  ScrollIcon as ScrollText,
  GearSixIcon as Settings,
  ShieldIcon as Shield,
  SlidersHorizontalIcon as SlidersHorizontal,
  SparkleIcon as Sparkle,
  StackIcon as Stack,
  StorefrontIcon as Store,
  UserIcon as User,
  UsersThreeIcon as UsersRound,
  WebhooksLogoIcon as Webhook,
} from '@phosphor-icons/react';
import type { SettingsSurface, SettingsTab } from './settings-tabs';
import { TAB_KEYWORDS } from './tab-keywords';
import type { RailGroup, RailItem } from './type';

/**
 * The old Customize overlay's `llm-*` `CustomizeSection` ids. `SettingsTab`
 * doesn't carry them — `settings-tabs.ts`'s `RENAMED_TABS` folds every one of
 * these into `'models'` inside `legacySectionRedirect`, which returns a full
 * new URL, so the sub-id itself is discarded at the redirect and never
 * becomes panel state. `parseSettingsTab` filters strictly against
 * `SETTINGS_TABS` and can never yield one either. They are a bounded, known,
 * seven-member legacy set (not live tabs — do not add them to
 * `SETTINGS_TABS`), kept here only so `isRailItemActive` can still recognize
 * a stale/raw deep link and light up the right rail row before the redirect
 * runs.
 */
type LegacyLlmSubTab =
  | 'llm-management'
  | 'llm-overview'
  | 'llm-providers'
  | 'llm-logs'
  | 'llm-budgets'
  | 'llm-keys'
  | 'llm-api';

/**
 * Whether a rail item is the active one for the current settings tab.
 *
 * `models` stands in for every `llm-*` sub-page so a deep-link into an LLM
 * sub-page (`llm-logs`, `llm-budgets`, ...) still lights up the single
 * Models rail entry, exactly like the old rail's `llm-management` stand-in
 * (see the legacy Customize rail). Every other item matches its own tab 1:1.
 */
export function isRailItemActive(item: RailItem, tab: SettingsTab | LegacyLlmSubTab): boolean {
  if (item.tab === 'models') return tab === 'models' || tab.startsWith('llm-');
  return item.tab === tab;
}

/* ------------------------------------------------------------------ *
 * Customize — what this project's agent is, and what it can do.
 * ------------------------------------------------------------------ */

const AGENTS_ITEM: RailItem = {
  tab: 'agents',
  label: 'Agents',
  icon: Robot,
  description: "Who does the work — each one's instructions, model, and access.",
};
const SKILLS_ITEM: RailItem = {
  tab: 'skills',
  label: 'Skills',
  icon: Sparkle,
  description: 'Reusable instructions your agents load on demand.',
};
// No description. `models-tab.tsx` draws its own header, and every word this
// row could carry ("project", "workspace") is the subject word of a DIFFERENT
// row — a description here answers queries Models is the wrong answer to. Its
// query terms live in `TAB_KEYWORDS` instead, where they can be curated.
const MODELS_ITEM: RailItem = {
  tab: 'models',
  label: 'Models',
  icon: Boxes,
};
const REVIEW_ITEM: RailItem = {
  tab: 'review',
  label: 'Review',
  icon: Inbox,
  description: 'Work waiting on a person before it can continue.',
};

const CONNECTORS_ITEM: RailItem = {
  tab: 'connectors',
  label: 'Connectors',
  icon: Plugs,
  description: 'Give agents access to outside tools and data.',
};
const APPS_ITEM: RailItem = {
  tab: 'apps',
  label: 'Apps',
  icon: Globe,
  // Not "this project publishes": "project" is the subject word of the
  // Projects nav row, and a description carrying it makes a one-word query for
  // Projects return this pane too.
  description: 'Web interfaces you publish from here, and who can open each one.',
};
const CHANNELS_ITEM: RailItem = {
  tab: 'channels',
  label: 'Channels',
  icon: ChatTeardropIcon,
  description: 'Reach your agent from the tools your team already uses.',
};
const VOICE_ITEM: RailItem = {
  tab: 'voice',
  label: 'Voice',
  icon: AudioLines,
  // Merged from the two that existed: this one, which never rendered, and
  // `voice-view.tsx`'s own three-sentence version, which did. The old line
  // here ("How Kortix sounds when it speaks and listens") describes picking a
  // voice; the pane is about sending the agent into a call. Say what the pane
  // does, at the length every other entry uses.
  description:
    'Send the agent into a call. It listens, answers out loud, and keeps working while you talk.',
};

// Both panes are one component, `components/projects/schedule-view.tsx`,
// switched by its `type` prop. Its own `KIND_COPY` used to carry these two
// sentences as `title`/`description` — the one screen-copy table in the app
// that also owned a pane heading. They live here now, like every other pane's,
// and `KIND_COPY` keeps the wording that is genuinely per-kind and appears
// INSIDE the pane (noun, empty state, column).
const SCHEDULES_ITEM: RailItem = {
  tab: 'schedules',
  label: 'Schedules',
  icon: AlarmClock,
  description: 'Have an agent do something on a repeating schedule, or once at a set time.',
};
const WEBHOOKS_ITEM: RailItem = {
  tab: 'webhooks',
  label: 'Webhooks',
  icon: Webhook,
  description: 'Give another app a private address that starts an agent when it sends a request.',
};

const SECRETS_ITEM: RailItem = {
  tab: 'secrets',
  label: 'Secrets',
  icon: KeyRound,
  description: 'Store encrypted values and control where each value can be used.',
};
const SANDBOX_ITEM: RailItem = {
  tab: 'sandbox',
  label: 'Sandbox templates',
  icon: Container,
  description: 'The recipe for the machine a session runs on.',
  docsHref: '/docs/work/runtime',
};
const SNAPSHOTS_ITEM: RailItem = {
  tab: 'snapshots',
  label: 'Snapshots',
  icon: Stack,
  // The pane opened on a log of `kortix-tpl-…` strings with nothing above it
  // saying what any of them were. Say what a snapshot is, in the one line that
  // is always on screen, before the log starts.
  description:
    'Every session starts on a machine Kortix prepared in advance. This is the record of each time it prepared one.',
  docsHref: '/docs/work/runtime',
};

const MARKETPLACE_ITEM: RailItem = {
  tab: 'marketplace',
  label: 'Marketplace',
  icon: Store,
  description: 'Agents and skills published by the Kortix community.',
};

/* ------------------------------------------------------------------ *
 * Settings — administration of the person, the project, the org.
 * ------------------------------------------------------------------ */

/**
 * The Upgrades tab is always reachable (it hosts the one-off registry
 * upgrade runner) and lives pinned at the very bottom of the Settings rail —
 * out of the scrolling groups (see the desktop footer / mobile tail in
 * whatever consumes `railGroups`).
 */
export const UPGRADE_ITEM: RailItem = {
  tab: 'upgrades',
  label: 'Upgrades',
  // The pane's ONLY description. It used to be dead: `upgrade-view.tsx` drew
  // its own header through `CustomizeSectionWrapper` with a second wording,
  // and repeated a third inside the one-off panel — three copies of one
  // sentence, none of them this one. That view reads this now, like every
  // other pane. Say what runs and what it can't do: "agent" and "nothing
  // merges" are the two facts a person needs before pressing Run.
  description:
    'Changes an agent makes to this workspace. Every run opens a change request for you to review — nothing merges on its own.',
  icon: ArrowUpCircle,
};

const SETTINGS_GROUPS: readonly RailGroup[] = [
  {
    label: 'You',
    items: [
      {
        tab: 'profile',
        label: 'Profile',
        icon: User,
      },
      {
        tab: 'preferences',
        label: 'Preferences',
        icon: SlidersHorizontal,
      },
      {
        tab: 'connected',
        label: 'Connected accounts',
        icon: Link,
      },
    ],
  },
  {
    label: 'Workspace',
    items: [
      {
        tab: 'general',
        label: 'General',
        icon: Settings,
      },
      {
        tab: 'members',
        label: 'Members',
        icon: UsersRound,
        description: 'Who can reach this workspace, and what each person can do.',
      },
      {
        tab: 'repositories',
        label: 'Repositories',
        icon: GitFork,
        description: "Where this workspace's code lives, and how to work on it from your computer.",
      },
    ],
  },
  {
    label: 'Organization',
    items: [
      {
        tab: 'organization',
        label: 'General',
        icon: Settings,
        // The pane opened on a bare "General" with nothing under it, so the
        // one thing always on screen said nothing about which scope you were
        // looking at — and this panel has three Generals (workspace, profile,
        // organization). Name the scope and what it holds, in one line.
        description: "Your organization's name and the sign-in rules everyone on it has to follow.",
      },
      {
        tab: 'billing',
        label: 'Billing',
        icon: CreditCard,
      },
      {
        tab: 'usage',
        label: 'Usage',
        icon: Coins,
      },
      {
        tab: 'groups',
        label: 'Groups',
        icon: Network,
      },
      {
        tab: 'roles',
        label: 'Roles',
        icon: Shield,
      },
      {
        tab: 'identity',
        label: 'Identity',
        icon: Fingerprint,
      },
      {
        tab: 'audit',
        label: 'Audit log',
        icon: ScrollText,
      },
    ],
  },
  {
    label: 'Developer',
    items: [
      {
        tab: 'api-keys',
        label: 'API keys',
        icon: ApiKeys,
        // The pane opened with a bare title and no line saying what a key is
        // for, so the first thing a reader met was a list of nouns
        // ("service accounts", "PAT lifecycle"). Say the job instead.
        description: 'Let the Kortix CLI, a script, or a CI job use this workspace.',
      },
      {
        tab: 'experimental',
        label: 'Experimental',
        icon: Flask,
        description: 'Features you can switch on before they are generally available.',
      },
    ],
  },
];

export interface RailFlags {
  marketplaceEnabled: boolean;
  llmGatewayAvailable: boolean;
  voiceEnabled: boolean;
  reviewEnabled: boolean;
  appsEnabled: boolean;
}

/**
 * The rail for one surface, with every flag-gated row spliced in at its own
 * position.
 *
 * Written as one literal per group with inline spreads, rather than a pass
 * that pushes optional rows onto a group it matched. That older shape had a
 * bug class this one cannot have: it returned a group on the FIRST flag that
 * matched, so a second gated row in the same group was silently dropped —
 * Marketplace defaults on for effectively every project, which made Review and
 * Voice unreachable. Here every gated row is written where it renders, and a
 * gated row is a spread, not a push, so it keeps its place in the group
 * instead of landing at the end.
 *
 * `llmGatewayAvailable` deliberately gates NOTHING here: the Models row is
 * always present, and that flag only controls whether the `llm-*`
 * sub-sections render INSIDE the Models pane. Getting this backwards makes
 * Models disappear for most projects, since most projects don't have the LLM
 * gateway on.
 *
 * Never returns an empty group — "Get more" exists only when Marketplace does.
 */
export function railGroups(surface: SettingsSurface, flags: RailFlags): readonly RailGroup[] {
  if (surface === 'settings') return SETTINGS_GROUPS;

  return [
    {
      label: 'Agent',
      items: [
        AGENTS_ITEM,
        SKILLS_ITEM,
        MODELS_ITEM,
        ...(flags.reviewEnabled ? [REVIEW_ITEM] : []),
      ],
    },
    {
      label: 'Reach',
      items: [
        CONNECTORS_ITEM,
        ...(flags.appsEnabled ? [APPS_ITEM] : []),
        CHANNELS_ITEM,
        ...(flags.voiceEnabled ? [VOICE_ITEM] : []),
      ],
    },
    { label: 'Automate', items: [SCHEDULES_ITEM, WEBHOOKS_ITEM] },
    { label: 'Runtime', items: [SECRETS_ITEM, SANDBOX_ITEM, SNAPSHOTS_ITEM] },
    ...(flags.marketplaceEnabled ? [{ label: 'Get more', items: [MARKETPLACE_ITEM] }] : []),
  ];
}

/** Every row that exists on either surface, flags ignored. See `railItemForTab`. */
const ALL_ITEMS: readonly RailItem[] = [
  AGENTS_ITEM,
  SKILLS_ITEM,
  MODELS_ITEM,
  REVIEW_ITEM,
  CONNECTORS_ITEM,
  APPS_ITEM,
  CHANNELS_ITEM,
  VOICE_ITEM,
  SCHEDULES_ITEM,
  WEBHOOKS_ITEM,
  SECRETS_ITEM,
  SANDBOX_ITEM,
  SNAPSHOTS_ITEM,
  MARKETPLACE_ITEM,
  UPGRADE_ITEM,
  ...SETTINGS_GROUPS.flatMap((g) => g.items),
];

/**
 * Whether one rail row answers a search query.
 *
 * Three sources, in the order a person would expect them to work: the label
 * (the word they are typing), the description (what the pane does), and
 * `TAB_KEYWORDS` (its aliases and the things it contains) — so "sso" finds
 * Identity, "cli" finds API keys, and "slack" finds Channels.
 *
 * **The keywords are shared with the command palette on purpose.** The rail
 * used to match label + description only, so the palette found Channels for
 * "slack" and this field — sitting directly above the Channels row — returned
 * "Nothing matches". One table, one answer. See `tab-keywords.ts`.
 */
export function railItemMatches(item: RailItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    item.label.toLowerCase().includes(q) ||
    (item.description?.toLowerCase().includes(q) ?? false) ||
    TAB_KEYWORDS[item.tab].includes(q)
  );
}

/**
 * The rail narrowed to a search query, with its grouping intact.
 *
 * **The groups survive the filter — that is the point.** A flat list of
 * matches would strip the one thing that tells Workspace › General and
 * Organization › General apart (see `RailItem.description`), so a result set
 * is still groups: every group that keeps at least one row keeps its heading,
 * in the same order, and a group with no matches disappears whole. Typing
 * "profile" leaves the "You" heading with Profile under it, not a bare row
 * floating where five groups used to be.
 *
 * **A group name is itself a query.** Typing "organization" keeps the whole
 * Organization group rather than nothing, because the group label is the only
 * name some of its rows share — a person looking for billing-adjacent
 * settings knows the group before they know which tab. A group matched this
 * way keeps every item; its rows are not filtered again against the same
 * query, or "organization" would match the group and then discard all seven
 * rows for not containing the word.
 *
 * Returns `groups` unchanged for a blank query, by identity, so an unfiltered
 * rail does no work and memoized callers see a stable reference.
 */
export function filterRailGroups(
  groups: readonly RailGroup[],
  query: string,
): readonly RailGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  return groups
    .map((group) =>
      group.label.toLowerCase().includes(q)
        ? group
        : { ...group, items: group.items.filter((item) => railItemMatches(item, q)) },
    )
    .filter((group) => group.items.length > 0);
}

/**
 * The `RailItem` for a tab, independent of any flag or surface.
 *
 * `railGroups(surface, flags)` answers "what does this user see", which is the
 * right question for the rail and the wrong one here: a pane's heading copy
 * does not change with a feature flag, and a pane can only render when its tab
 * is already reachable. So this walks `ALL_ITEMS` — both surfaces, gated rows
 * included — and takes neither a surface nor flags.
 *
 * Returns `undefined` for a tab with no rail row (`SettingsTab` has members
 * that fold into another tab, e.g. the `llm-*` ids that resolve to `models`),
 * so callers must handle absence rather than assume a row exists.
 */
export function railItemForTab(tab: SettingsTab): RailItem | undefined {
  return ALL_ITEMS.find((item) => item.tab === tab);
}
