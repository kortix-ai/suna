import {
  AlarmIcon as AlarmClock,
  BracketsCurlyIcon as ApiKeys,
  WaveformIcon as AudioLines,
  ArrowCircleUpIcon as ArrowUpCircle,
  CubeIcon as Boxes,
  ChatsIcon as ChatMessages,
  CommandIcon as Command,
  ShippingContainerIcon as Container,
  CoinsIcon as Coins,
  CreditCardIcon as CreditCard,
  FingerprintIcon as Fingerprint,
  FlaskIcon as Flask,
  GitForkIcon as GitFork,
  TrayIcon as Inbox,
  KeyIcon as KeyRound,
  LinkIcon as Link,
  MonitorIcon as Monitor,
  NetworkIcon as Network,
  ScrollIcon as ScrollText,
  ShieldIcon as Shield,
  GearSixIcon as Settings,
  StackIcon as Stack,
  StorefrontIcon as Store,
  SlidersHorizontalIcon as SlidersHorizontal,
  UsersThreeIcon as UsersRound,
  UserIcon as User,
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
 * (see `customize/rail.ts`). Every other item matches its own tab 1:1.
 */
export function isRailItemActive(
  item: RailItem,
  tab: SettingsTab | LegacyLlmSubTab,
): boolean {
  if (item.tab === 'models') return tab === 'models' || tab.startsWith('llm-');
  return item.tab === tab;
}

const COMPUTERS_ITEM: RailItem = { tab: 'computers', label: 'Computers', icon: Monitor };
const MARKETPLACE_ITEM: RailItem = { tab: 'marketplace', label: 'Marketplace', icon: Store };
const REVIEW_ITEM: RailItem = { tab: 'review', label: 'Review', icon: Inbox };
const VOICE_ITEM: RailItem = { tab: 'voice', label: 'Voice', icon: AudioLines };

/**
 * The Upgrades tab is always reachable (it hosts the one-off registry
 * upgrade runner) and lives pinned at the very bottom of the rail — out of
 * the scrolling groups (see the desktop footer / mobile tail in whatever
 * consumes `railGroups`). Mirrors `customize/rail.ts`'s `UPGRADE_ITEM`.
 */
export const UPGRADE_ITEM: RailItem = {
  tab: 'upgrades',
  label: 'Upgrades',
  icon: ArrowUpCircle,
};

const STATIC_GROUPS: readonly RailGroup[] = [
  {
    label: 'You',
    items: [
      { tab: 'profile', label: 'Profile', icon: User },
      { tab: 'preferences', label: 'Preferences', icon: SlidersHorizontal },
      { tab: 'connected', label: 'Connected accounts', icon: Link },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { tab: 'general', label: 'General', icon: Settings },
      { tab: 'members', label: 'Members', icon: UsersRound },
      { tab: 'secrets', label: 'Secrets', icon: KeyRound },
      { tab: 'channels', label: 'Channels', icon: ChatMessages },
      { tab: 'repositories', label: 'Repositories', icon: GitFork },
      { tab: 'schedules', label: 'Schedules', icon: AlarmClock },
      { tab: 'webhooks', label: 'Webhooks', icon: Webhook },
    ],
  },
  {
    label: 'Agent',
    items: [
      { tab: 'models', label: 'Models', icon: Boxes },
      { tab: 'instructions', label: 'Instructions', icon: Command },
      { tab: 'sandbox', label: 'Sandbox templates', icon: Container },
      { tab: 'snapshots', label: 'Snapshots', icon: Stack },
    ],
  },
  {
    label: 'Organization',
    items: [
      { tab: 'billing', label: 'Billing', icon: CreditCard },
      { tab: 'usage', label: 'Usage', icon: Coins },
      { tab: 'groups', label: 'Groups', icon: Network },
      { tab: 'roles', label: 'Roles', icon: Shield },
      { tab: 'identity', label: 'Identity', icon: Fingerprint },
      { tab: 'audit', label: 'Audit log', icon: ScrollText },
    ],
  },
  {
    label: 'Developer',
    items: [
      { tab: 'api-keys', label: 'API keys', icon: ApiKeys },
      { tab: 'experimental', label: 'Experimental', icon: Flask },
    ],
  },
];

export interface RailFlags {
  tunnelEnabled: boolean;
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
 * exact bug `customize/rail.ts:110` documents: Marketplace defaults ON for
 * effectively every project, so an early return on the Agent group's first
 * matching flag made Review (and Voice) unreachable.
 */
export function railGroups(flags: RailFlags): readonly RailGroup[] {
  return STATIC_GROUPS.map((g) => {
    if (g.label === 'Workspace') {
      const items = [...g.items];
      if (flags.tunnelEnabled) items.push(COMPUTERS_ITEM);
      return { ...g, items };
    }
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
