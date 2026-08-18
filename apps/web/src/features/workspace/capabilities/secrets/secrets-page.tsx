'use client';

import { useStandaloneCapabilityNav } from '@/features/workspace/capabilities/shared/standalone-settings-nav';
import { SecretsView } from '@/features/workspace/customize/sections/view/secrets-view';
import { SettingsNavProvider } from '@/features/workspace/shared/settings-nav-context';

/**
 * The page body for /projects/[id]/secrets — Secrets graduated out of the
 * project Settings sub-nav into its own top-level Customize tab. It is the
 * one section editor-tier (`project.secret.read/write`, deliberately not
 * member baseline — see `lib/project-actions.ts`'s header comment) rather
 * than reusing `project.customize.write`, and that gate travels with the
 * component itself, unchanged by this move.
 *
 * `SecretsView` calls `useSettingsNav()` internally (e.g. a cross-link to
 * Models when a secret backs a provider key), which throws outside a
 * provider — `useStandaloneCapabilityNav` is that provider's value for a
 * page that is not the overlay or `/config`.
 *
 * No chrome of its own. `SecretsView` renders `CapabilityPageShell` — the same
 * shell Connectors, Agents, Skills and Triggers use — so Secrets is the same
 * `max-w-5xl` column with the same heading and header group as its four
 * sibling tabs. That shell is also the route's scroll container
 * (`min-h-0 flex-1 overflow-y-auto`), which the `(capabilities)` layout
 * requires: it is a bounded `h-svh` column, and something inside it has to
 * scroll or the tab bar above scrolls away with the content.
 *
 * This wrapper used to bring its own scroll box and its own `max-w-2xl`
 * column, which is what made this tab read as a different product from the
 * four beside it — the same wrapper `triggers-page.tsx` shed for the same
 * reason.
 */
export function SecretsPage({ projectId }: { projectId: string }) {
  const settingsNav = useStandaloneCapabilityNav(projectId, 'secrets');
  return (
    <SettingsNavProvider value={settingsNav}>
      <SecretsView projectId={projectId} />
    </SettingsNavProvider>
  );
}
