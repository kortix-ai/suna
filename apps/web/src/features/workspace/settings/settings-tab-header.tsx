import { Button } from '@/components/ui/button';
import { SettingsSectionHeader } from '@/components/ui/settings-section-header';
import { BookOpenIcon } from '@phosphor-icons/react';
import Link from 'next/link';

import { railItemForTab } from './rail';
import type { SettingsTab } from './settings-tabs';

/**
 * The pane heading for one settings tab: title, description, and the action row.
 *
 * The action row holds up to two things. A "Docs" button comes first, rendered
 * automatically for any tab whose rail entry declares a `docsHref` (see
 * `type.ts`) — the caller does not pass it and cannot style it, so every pane's
 * docs affordance is the same button in the same place. The tab's own `action`
 * (an Invite button, a role explainer, a New template button) sits after it.
 */
export function SettingsTabHeader({ tab, action }: { tab: SettingsTab; action?: React.ReactNode }) {
  const item = railItemForTab(tab);
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
