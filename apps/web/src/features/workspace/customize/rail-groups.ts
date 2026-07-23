import { AlarmClock, ChatMessages, Sparkles } from '@mynaui/icons-react';
import { Bot, Boxes, Container, GitFork, KeyRound, Plug, Webhook } from 'lucide-react';
import { LuSettings, LuUsersRound } from 'react-icons/lu';

import type { RailGroup } from './type';

/**
 * The base rail groups — flag-gated extras (Marketplace, Meet, Computers, LLM,
 * Review) are spliced in by `customize-panel.tsx`'s `railGroups()`, but this
 * is the fixed, always-present shape every project sees.
 *
 * **Build** is exactly Agents + Skills. The Commands tab (legacy opencode-native
 * slash-command CRUD) and the standalone Runtime tab/section were both removed —
 * native harness slash-commands will surface via ACP in the composer instead
 * (separate work), and which harness/runtime an agent uses is now shown
 * directly on the agent row/detail in Agents (see `agents-view.tsx`) rather
 * than living as its own section. The Runtime section's sole-path capability
 * — declaring/renaming runtime profiles — moved into Agents too (see
 * `runtime-profiles-manager.tsx`); per-harness model connections were already
 * fully covered by the Models page and needed no relocation.
 */
export const GROUPS: readonly RailGroup[] = [
  {
    label: 'Build',
    items: [
      { section: 'agents', label: 'Agents', icon: Bot },
      { section: 'skills', label: 'Skills', icon: Sparkles },
    ],
  },
  {
    label: 'Connect',
    items: [
      // Models (the two-door connect surface) leads the Connect group so the
      // connect flow is reachable from the rail, not only via composer
      // deep-links. `customize-panel.tsx` filters it out for projects where the
      // managed gateway isn't available (the same `llmGatewayAvailable` gate
      // that used to splice it in here).
      { section: 'llm-management', label: 'Models', icon: Boxes },
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
      { section: 'members', label: 'Members', icon: LuUsersRound },
      { section: 'settings', label: 'Settings', icon: LuSettings },
    ],
  },
];
