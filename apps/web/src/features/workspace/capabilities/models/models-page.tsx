'use client';

import { getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

import { useStandaloneCapabilityNav } from '@/features/workspace/capabilities/shared/standalone-settings-nav';
import { ModelsTab } from '@/features/workspace/settings/tabs/models-tab';
import { SettingsNavProvider } from '@/features/workspace/shared/settings-nav-context';
import { isLlmGatewayEnabled } from '@/lib/llm-gateway';

/**
 * The page body for /projects/[id]/models — Models graduated out of the
 * project Settings sub-nav into its own top-level Customize tab, alongside
 * Connectors / Agents / Skills / Triggers. Picking a model is not
 * "configuration" the way Secrets or Channels are; it is a first-class
 * decision a project needs early and often.
 *
 * No chrome of its own. `ModelsTab` renders `CapabilityPageShell` — the same
 * shell Connectors, Agents, Skills, Triggers and Secrets use — so Models is
 * the same `max-w-5xl` column with the same heading and header group as its
 * five sibling tabs. That shell is also the route's scroll container
 * (`min-h-0 flex-1 overflow-y-auto`), which the `(capabilities)` layout
 * requires: it is a bounded `h-svh` column, and something inside it has to
 * scroll or the tab bar above scrolls away with the content. This page used
 * to add its own `flex min-h-0 flex-1 overflow-hidden` wrapper around
 * `ModelsTab` — that was the bounded box the OLD local-header layout needed
 * to hand `LlmManagementView` a real height to fill; the shell replaces it,
 * the same wrapper `triggers-page.tsx` and `secrets-page.tsx` shed for the
 * same reason.
 *
 * `ModelsTab` also calls `useSettingsNav()` internally (to jump to a
 * deep-linked `llm-*` sub-tab), which throws outside a provider —
 * `useStandaloneCapabilityNav` is that provider's value for a page that is
 * not the overlay or `/config`.
 */
export function ModelsPage({ projectId }: { projectId: string }) {
  const detail = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
    ...contract('config'),
  });

  // Gates the pane's CONTENT, not the tab's visibility — a project without
  // the managed gateway still opens Models, it just sees a narrower set of
  // providers. Getting this backwards hides the tab from most projects.
  const llmGatewayEnabled = isLlmGatewayEnabled(detail.data?.project);
  const settingsNav = useStandaloneCapabilityNav(projectId, 'models');

  return (
    <SettingsNavProvider value={settingsNav}>
      <ModelsTab projectId={projectId} llmGatewayEnabled={llmGatewayEnabled} />
    </SettingsNavProvider>
  );
}
