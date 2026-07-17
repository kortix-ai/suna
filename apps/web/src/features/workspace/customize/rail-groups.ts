import { AlarmClock, ChatMessages, Command, Sparkles } from '@mynaui/icons-react';
import { Bot, Container, Cpu, History, KeyRound, Plug, Terminal, Webhook } from 'lucide-react';
import { LuSettings, LuUsersRound } from 'react-icons/lu';

import type { RailGroup } from './type';

/**
 * The base rail groups — flag-gated extras (Marketplace, Meet, Computers, LLM,
 * Review) are spliced in by `customize-panel.tsx`'s `railGroups()`, but this
 * is the fixed, always-present shape every project sees.
 *
 * WS5-P5-a: **Build** leads with the ACP core, in this exact order — Agents,
 * Runtime, Skills, Commands. Runtime (WS5-P2-a) landed provisionally right
 * after Agents; this ordering is now final, not a placeholder — rail item
 * count is unchanged this cycle (14 base + 6 flag-gated = 20 items stay; ordering + grouping only).
 */
export const GROUPS: readonly RailGroup[] = [
  {
    label: 'Build',
    items: [
      { section: 'agents', label: 'Agents', icon: Bot },
      { section: 'runtime', label: 'Runtime', icon: Cpu },
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
    label: 'Workspace',
    items: [
      { section: 'changes', label: 'Changes', icon: History },
      { section: 'sandbox', label: 'Sandbox', icon: Container },
      { section: 'dev', label: 'Dev', icon: Terminal },
    ],
  },
  {
    label: 'Manage',
    items: [
      { section: 'members', label: 'Members', icon: LuUsersRound },
      { section: 'settings', label: 'Settings', icon: LuSettings },
    ],
  },
];
