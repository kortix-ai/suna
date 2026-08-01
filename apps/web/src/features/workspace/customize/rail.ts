import type { CustomizeSection } from '@/lib/customize-sections';
import {
  AlarmIcon as AlarmClock,
  ArrowCircleUpIcon as ArrowUpCircle,
  ChatsIcon as ChatMessages,
  CommandIcon as Command,
  CubeIcon as Boxes,
  GearSixIcon as LucideSettings,
  GitForkIcon as GitFork,
  KeyIcon as KeyRound,
  MonitorIcon as Monitor,
  PlugIcon as Plug,
  RobotIcon as Bot,
  ShippingContainerIcon as Container,
  SparkleIcon as Sparkles,
  StorefrontIcon as Store,
  TrayIcon as Inbox,
  UsersThreeIcon as LucideUsersRound,
  WaveformIcon as AudioLines,
  WebhooksLogoIcon as Webhook,
} from '@phosphor-icons/react';
import type { RailGroup, RailItem } from './type';

/**
 * Whether a rail item is the active one for the current section.
 *
 * `llm-management` stands in for every `llm-*` sub-section so deep-links into
 * an LLM sub-page still light up the single LLM rail entry. Every other item —
 * including the independent Agents, Skills, and Commands entries — matches its
 * own section 1:1.
 */
export function isRailItemActive(item: RailItem, section: CustomizeSection): boolean {
  if (item.section === 'llm-management') return section.startsWith('llm-');
  return item.section === section;
}

export const COMPUTERS_ITEM: RailItem = { section: 'computers', label: 'Computers', icon: Monitor };

export const MARKETPLACE_ITEM: RailItem = {
  section: 'marketplace',
  label: 'Marketplace',
  icon: Store,
};

export const VOICE_ITEM: RailItem = { section: 'voice', label: 'Voice', icon: AudioLines };

export const REVIEW_ITEM: RailItem = { section: 'review', label: 'Review', icon: Inbox };

/**
 * The Upgrades section is always reachable (it hosts the one-off prompt runner)
 * and lives pinned at the very bottom of the rail — out of the scrolling nav (see
 * the desktop footer / mobile tail in customize-panel). When a registry upgrade is
 * actually applicable (e.g. the project is still on a v1 manifest) it carries a
 * small attention dot instead of claiming a more prominent slot.
 */
export const UPGRADE_ITEM: RailItem = {
  section: 'upgrade',
  label: 'Upgrades',
  icon: ArrowUpCircle,
};

export const LLM_ITEM: RailItem = { section: 'llm-management', label: 'LLM', icon: Boxes };

const GROUPS: readonly RailGroup[] = [
  {
    label: 'Build',
    items: [
      { section: 'agents', label: 'Agents', icon: Bot },
      { section: 'skills', label: 'Skills', icon: Sparkles },
      { section: 'commands', label: 'Commands', icon: Command },
    ],
  },
  {
    label: 'Connect',
    items: [
      { section: 'connectors', label: 'Connectors', icon: Plug },
      { section: 'secrets', label: 'Environment variables', icon: KeyRound },
      { section: 'channels', label: 'Channels', icon: ChatMessages },
    ],
  },
  {
    label: 'Automate',
    items: [
      { section: 'schedules', label: 'Schedules', icon: AlarmClock },
      { section: 'webhooks', label: 'Webhooks', icon: Webhook },
    ],
  },
  {
    label: 'Manage',
    items: [
      { section: 'git', label: 'Git', icon: GitFork },
      { section: 'sandbox', label: 'Sandbox templates', icon: Container },
      { section: 'members', label: 'Members', icon: LucideUsersRound },
      { section: 'settings', label: 'Settings', icon: LucideSettings },
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
 * The rail, composed from the static groups plus every flag-gated item.
 *
 * Each group accumulates ALL of its optional items in one pass — a group is
 * never returned early on the first flag that matches, or a second flag-gated
 * item in the same group would be silently dropped (Marketplace defaults ON for
 * every project, so an early return there made Review unreachable and bounced
 * the panel back to the default section).
 */
export function railGroups(flags: RailFlags): readonly RailGroup[] {
  return GROUPS.map((g) => {
    if (g.label === 'Build') {
      const items = [...g.items];
      if (flags.marketplaceEnabled) items.push(MARKETPLACE_ITEM);
      if (flags.reviewEnabled) items.push(REVIEW_ITEM);
      return { ...g, items };
    }
    if (g.label === 'Connect') {
      const items = [...g.items];
      if (flags.voiceEnabled) items.push(VOICE_ITEM);
      if (flags.tunnelEnabled) items.push(COMPUTERS_ITEM);
      if (flags.llmGatewayAvailable) items.push(LLM_ITEM);
      return { ...g, items };
    }
    return g;
  });
}
