import {
  AlarmIcon as AlarmClock,
  BracketsCurlyIcon as ApiKeys,
  ArrowCircleUpIcon as ArrowUpCircle,
  WaveformIcon as AudioLines,
  CubeIcon as Boxes,
  ChatsIcon as ChatMessages,
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
        description: 'Your name, avatar, and how you sign in.',
      },
      {
        tab: 'preferences',
        label: 'Preferences',
        icon: SlidersHorizontal,
        description: 'How Kortix looks and behaves on this device.',
      },
      {
        tab: 'connected',
        label: 'Connected accounts',
        icon: Link,
        description: 'The accounts Kortix acts on your behalf with.',
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
        description: "This workspace's name, icon, and where its sandboxes run.",
      },
      {
        tab: 'members',
        label: 'Members',
        icon: UsersRound,
        description: 'Who can reach this workspace, and what each person can do.',
      },
      {
        tab: 'secrets',
        label: 'Secrets',
        icon: KeyRound,
        description: 'Values your agents read at run time, never shown in plain text.',
      },
      {
        tab: 'channels',
        label: 'Channels',
        icon: ChatTeardropIcon,
        description: 'Where Kortix posts and listens for work.',
      },
      {
        tab: 'repositories',
        label: 'Repositories',
        icon: GitFork,
        description: 'The repositories this workspace can read and write.',
      },
      {
        tab: 'schedules',
        label: 'Schedules',
        icon: AlarmClock,
        description: 'Runs Kortix starts on a timer, without anyone asking.',
      },
      {
        tab: 'webhooks',
        label: 'Webhooks',
        icon: Webhook,
        description: 'Runs an outside system can start by calling Kortix.',
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
        description: 'The providers your agents think with, and the keys behind them.',
      },
      {
        tab: 'instructions',
        label: 'Instructions',
        icon: Command,
        description: 'Standing guidance and slash commands your agents follow.',
      },
      {
        tab: 'sandbox',
        label: 'Sandbox templates',
        icon: Container,
        description: 'The machine image your agents get when a session starts.',
      },
      {
        tab: 'snapshots',
        label: 'Snapshots',
        icon: Stack,
        description: 'Every sandbox image build, and why any of them failed.',
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
        description: "Your organization's name, sign-in rules, and deletion.",
      },
      {
        tab: 'billing',
        label: 'Billing',
        icon: CreditCard,
        description: 'Your plan, your wallet, and what Kortix charges for.',
      },
      {
        tab: 'usage',
        label: 'Usage',
        icon: Coins,
        description: 'What this organization has spent, and on which sessions.',
      },
      {
        tab: 'groups',
        label: 'Groups',
        icon: Network,
        description: 'Bundles of people you can grant access to all at once.',
      },
      {
        tab: 'roles',
        label: 'Roles',
        icon: Shield,
        description: 'What each role is allowed to do across the organization.',
      },
      {
        tab: 'identity',
        label: 'Identity',
        icon: Fingerprint,
        description: 'Single sign-on and directory provisioning for your organization.',
      },
      {
        tab: 'audit',
        label: 'Audit log',
        icon: ScrollText,
        description: 'A record of who changed what, and when.',
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
        description: 'Tokens that let scripts and CI act as this organization.',
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
