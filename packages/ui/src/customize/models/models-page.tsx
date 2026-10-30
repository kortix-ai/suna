'use client';

import { useStandaloneCapabilityNav } from '../shared/standalone-settings-nav';
import { LlmManagementView } from '../sections/gateway-view';
import { SettingsNavProvider } from '../../internal/layout/settings-nav-context';
import { AppReturnBar } from './app-return-bar';
import type { ResourceScope } from '../shared/agent-resource-scope';
import type { ReactNode } from 'react';

/**
 * The page body for /projects/[id]/models — Models graduated out of the
 * project Settings sub-nav into its own top-level Customize tab, alongside
 * Connectors / Agents / Skills / Triggers. Picking a model is not
 * "configuration" the way Secrets or Channels are; it is a first-class
 * decision a project needs early and often.
 *
 * No chrome of its own. `LlmManagementView` renders `CapabilityPageShell` — the same
 * shell Connectors, Agents, Skills, Triggers and Secrets use — so Models is
 * the same `max-w-5xl` column with the same heading and header group as its
 * five sibling tabs. That shell is also the route's scroll container
 * (`min-h-0 flex-1 overflow-y-auto`), which the `(capabilities)` layout
 * requires: it is a bounded `h-svh` column, and something inside it has to
 * scroll or the tab bar above scrolls away with the content. This page used
 * to add its own `flex min-h-0 flex-1 overflow-hidden` wrapper around
 * `LlmManagementView` — that was the bounded box the OLD local-header layout needed
 * to hand `LlmManagementView` a real height to fill; the shell replaces it,
 * the same wrapper `triggers-page.tsx` and `secrets-page.tsx` shed for the
 * same reason.
 *
 * `LlmManagementView` also calls `useSettingsNav()` internally (to jump to a
 * deep-linked `llm-*` sub-tab), which throws outside a provider —
 * `useStandaloneCapabilityNav` is that provider's value for a page that is
 * not the overlay or `/config`.
 */
export function ModelsPage({
  projectId,
  surface,
  agentSettings,
}: {
  projectId: string;
  /** `agent` renders the same page on one agent's editor (`agent-page.tsx`),
   *  with `agentSettings` as its leading "This agent" tab. */
  surface?: ResourceScope;
  agentSettings?: ReactNode;
}) {
  const settingsNav = useStandaloneCapabilityNav(projectId, 'models');

  return (
    <SettingsNavProvider value={settingsNav}>
      <LlmManagementView projectId={projectId} surface={surface} agentSettings={agentSettings} />
      {/* Mobile's "connect a model provider" hand-off; nothing without ?return_to. */}
      <AppReturnBar projectId={projectId} />
    </SettingsNavProvider>
  );
}
