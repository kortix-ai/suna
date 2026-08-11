import {
  AlarmIcon as AlarmClock,
  BracketsCurlyIcon as ApiKeys,
  ArrowCircleUpIcon as ArrowUpCircle,
  WaveformIcon as AudioLines,
  CubeIcon as Boxes,
  ChatTeardropIcon,
  CoinsIcon as Coins,
  CommandIcon as Command,
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
  description: 'How Kortix sounds when it speaks and listens.',
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
  description: 'One-off upgrades this workspace can run against its own data.',
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
      },
      {
        tab: 'channels',
        label: 'Channels',
        icon: ChatTeardropIcon,
      },
      {
        tab: 'repositories',
        label: 'Repositories',
        icon: GitFork,
      },
      {
        tab: 'schedules',
        label: 'Schedules',
        icon: AlarmClock,
      },
      {
        tab: 'webhooks',
        label: 'Webhooks',
        icon: Webhook,
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
        tab: 'instructions',
        label: 'Instructions',
        icon: Command,
      },
      {
        tab: 'sandbox',
        label: 'Sandbox templates',
        icon: Container,
      },
      {
        tab: 'snapshots',
        label: 'Snapshots',
        icon: Stack,
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
