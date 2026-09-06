import { Button } from '@/components/ui/button';
import { SettingsSectionHeader } from '@/components/ui/settings-section-header';
import { BookOpenIcon } from '@phosphor-icons/react';
import Link from 'next/link';

import { railItemForTab } from './rail';
import type { SettingsTab } from './settings-tabs';

/**
 * The heading copy for one pane id: title, one-line description, optional
 * docs link — from the overlay's rail (`rail.ts`), the one registry left.
 *
 * It used to consult a second registry, the config page's
 * `project-settings-sections.ts`, for the panes that lived at
 * `/projects/[id]/config`. That page was retired on 2026-09-02 and its panes
 * are rail rows now, so one lookup answers for every pane.
 */
function headerCopy(
  tab: string,
): { label: string; description?: string; docsHref?: string } | undefined {
  // `railItemForTab` compares ids as strings, so a non-`SettingsTab` id simply
  // finds nothing rather than misbehaving.
  return railItemForTab(tab as SettingsTab);
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
