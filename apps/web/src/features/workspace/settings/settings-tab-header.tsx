import { Button } from '@/components/ui/button';
import { SettingsSectionHeader } from '@/components/ui/settings-section-header';
import { BookOpenIcon } from '@phosphor-icons/react';
import Link from 'next/link';

import { projectSettingsSection } from '@/features/workspace/capabilities/project-settings/project-settings-sections';

import { railItemForTab } from './rail';
import type { SettingsTab } from './settings-tabs';

/**
 * The heading copy for one pane id: title, one-line description, optional
 * docs link.
 *
 * Two registries answer it, because the panes now live on two surfaces. The
 * settings overlay's rail (`rail.ts`) owns Profile, Preferences and Connected
 * accounts. Every project-configuration pane moved to the Customize bar's
 * Settings tab and its copy moved with it, into
 * `capabilities/project-settings/project-settings-sections.ts`. A pane
 * component does not know or care which host mounted it, so it names its id
 * and this resolves it.
 *
 * Rail first: an id that is a live settings tab can never also be a project
 * section, so the order is a tie-break that never fires — it just states which
 * registry is authoritative if one ever did.
 */
function headerCopy(
  tab: string,
): { label: string; description?: string; docsHref?: string } | undefined {
  // `railItemForTab` compares ids as strings, so a non-`SettingsTab` id simply
  // finds nothing rather than misbehaving.
  return railItemForTab(tab as SettingsTab) ?? projectSettingsSection(tab as never);
}

/**
 * The pane heading for one settings tab: title, description, and the action row.
 *
 * The action row holds up to two things. A "Docs" button comes first, rendered
 * automatically for any tab whose registry entry declares a `docsHref` — the
 * caller does not pass it and cannot style it, so every pane's docs affordance
 * is the same button in the same place. The tab's own `action` (an Invite
 * button, a role explainer, a New template button) sits after it.
 *
 * `tab` is a plain `string`, not a union: a pane may be hosted by the settings
 * overlay or by the Customize bar's Settings tab, and each host has its own id
 * vocabulary. `headerCopy` below resolves both. An id in neither registry
 * renders nothing — which is why `tab-content-width.test.ts` pins that every
 * pane's id actually resolves.
 */
export function SettingsTabHeader({ tab, action }: { tab: string; action?: React.ReactNode }) {
  const item = headerCopy(tab);
  if (!item) return null;

  const docs = item.docsHref ? (
    <Button asChild variant="secondary" size="sm" className="gap-1.5">
      {/* New tab: a settings pane opens over live work, and following a link
          in place would discard whatever the person was doing behind it. */}
      <Link href={item.docsHref} target="_blank" rel="noreferrer">
        <BookOpenIcon className="size-3.5 shrink-0" />
        Docs
      </Link>
    </Button>
  ) : null;

  return (
    <SettingsSectionHeader
      title={item.label}
      description={item.description}
      action={
        docs || action ? (
          <div className="flex min-w-0 items-center gap-2">
            {docs}
            {action}
          </div>
        ) : undefined
      }
      className="pb-1"
    />
  );
}
