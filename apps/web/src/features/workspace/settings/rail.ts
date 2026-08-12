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
  TrayIcon as Inbox,
  KeyIcon as KeyRound,
  LinkIcon as Link,
  NetworkIcon as Network,
  ScrollIcon as ScrollText,
  GearSixIcon as Settings,
  ShieldIcon as Shield,
  SlidersHorizontalIcon as SlidersHorizontal,
  StackIcon as Stack,
  StorefrontIcon as Store,
  UserIcon as User,
  UsersThreeIcon as UsersRound,
  WebhooksLogoIcon as Webhook,
} from '@phosphor-icons/react';
import type { SettingsTab } from './settings-tabs';
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

const MARKETPLACE_ITEM: RailItem = {
  tab: 'marketplace',
  label: 'Marketplace',
  icon: Store,
  description: 'Agents and skills published by the Kortix community.',
};
const REVIEW_ITEM: RailItem = {
  tab: 'review',
  label: 'Review',
  icon: Inbox,
  description: 'Work waiting on a person before it can continue.',
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

/**
 * The Upgrades tab is always reachable (it hosts the one-off registry
 * upgrade runner) and lives pinned at the very bottom of the rail — out of
 * the scrolling groups (see the desktop footer / mobile tail in whatever
 * consumes `railGroups`). Mirrors the legacy Customize rail's `UPGRADE_ITEM`.
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

const STATIC_GROUPS: readonly RailGroup[] = [
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
      },
      {
        tab: 'secrets',
        label: 'Secrets',
        icon: KeyRound,
        description: 'Store encrypted values and control where each value can be used.',
      },
      {
        tab: 'channels',
        label: 'Channels',
        icon: ChatTeardropIcon,
        description: 'Reach your agent from the tools your team already uses.',
      },
      {
        tab: 'repositories',
        label: 'Repositories',
        icon: GitFork,
        description: "Where this workspace's code lives, and how to work on it from your computer.",
      },
      // Both panes are one component, `components/projects/schedule-view.tsx`,
      // switched by its `type` prop. Its own `KIND_COPY` used to carry these
      // two sentences as `title`/`description` — the one screen-copy table in
      // the app that also owned a pane heading. They live here now, like every
      // other pane's, and `KIND_COPY` keeps the wording that is genuinely
      // per-kind and appears INSIDE the pane (noun, empty state, column).
      {
        tab: 'schedules',
        label: 'Schedules',
        icon: AlarmClock,
        description: 'Have an agent do something on a repeating schedule, or once at a set time.',
      },
      {
        tab: 'webhooks',
        label: 'Webhooks',
        icon: Webhook,
        description:
          'Give another app a private address that starts an agent when it sends a request.',
      },
    ],
  },
  {
    label: 'Agent',
    items: [
      {
        tab: 'models',
        label: 'Models',
        icon: Boxes,
      },
      {
        tab: 'sandbox',
        label: 'Sandbox templates',
        icon: Container,
        description: 'The recipe for the machine a session runs on.',
        docsHref: '/docs/work/runtime',
      },
      {
        tab: 'snapshots',
        label: 'Snapshots',
        icon: Stack,
        // The pane opened on a log of `kortix-tpl-…` strings with nothing
        // above it saying what any of them were. Say what a snapshot is, in
        // the one line that is always on screen, before the log starts.
        description:
          'Every session starts on a machine Kortix prepared in advance. This is the record of each time it prepared one.',
        docsHref: '/docs/work/runtime',
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
      },
    ],
  },
];

export interface RailFlags {
  marketplaceEnabled: boolean;
  llmGatewayAvailable: boolean;
  voiceEnabled: boolean;
  reviewEnabled: boolean;
}

/**
 * The rail, composed from the five static groups plus every flag-gated item.
 *
 * `models` (Agent group) is always present — `llmGatewayAvailable` only
 * controls whether the `llm-*` sub-sections render inside the Models tab, it
 * does NOT gate the row. Getting this backwards makes Models disappear for
 * most projects, since most projects don't have the LLM gateway on.
 *
 * Each group accumulates ALL of its optional items in one pass — a group is
 * never returned early on the first flag that matches, or a second
 * flag-gated item in the same group would be silently dropped. This is the
 * exact bug the legacy Customize rail once documented: Marketplace defaults ON for
 * effectively every project, so an early return on the Agent group's first
 * matching flag made Review (and Voice) unreachable.
 */
export function railGroups(flags: RailFlags): readonly RailGroup[] {
  return STATIC_GROUPS.map((g) => {
    if (g.label === 'Agent') {
      const items = [...g.items];
      if (flags.marketplaceEnabled) items.push(MARKETPLACE_ITEM);
      if (flags.reviewEnabled) items.push(REVIEW_ITEM);
      if (flags.voiceEnabled) items.push(VOICE_ITEM);
      return { ...g, items };
    }
    return g;
  });
}

/**
 * The `RailItem` for a tab, independent of any flag.
 *
 * `railGroups(flags)` answers "what does this user see", which is the right
 * question for the rail and the wrong one here: a pane's heading copy does
 * not change with a feature flag, and a pane can only render when its tab is
 * already reachable. So this walks every item — the five static groups plus
 * the four flag-gated ones — and does not take flags at all.
 *
 * Returns `undefined` for a tab with no rail row (`SettingsTab` has members
 * that fold into another tab, e.g. the `llm-*` ids that resolve to `models`),
 * so callers must handle absence rather than assume a row exists.
 */
export function railItemForTab(tab: SettingsTab): RailItem | undefined {
  for (const group of STATIC_GROUPS) {
    const found = group.items.find((item) => item.tab === tab);
    if (found) return found;
  }
  return [MARKETPLACE_ITEM, REVIEW_ITEM, VOICE_ITEM, UPGRADE_ITEM].find((item) => item.tab === tab);
}
