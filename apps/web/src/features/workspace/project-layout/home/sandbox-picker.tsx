'use client';

import { useTranslations } from 'next-intl';

import {
  describeSandboxTemplate,
  SandboxTemplateMenu,
} from '@/features/workspace/shared/sandbox-template-menu';
import { cn } from '@/lib/utils';
import type { SandboxTemplate } from '@kortix/sdk';

/**
 * The sandbox-template override for the next session, as a pill on the
 * composer's toolbar. The menu itself is the shared `SandboxTemplateMenu` —
 * the agent editor's Workspace page opens the same one — so the two never
 * describe a template differently.
 */
export function SandboxPicker({
  items,
  activeSlug,
  selectedSlug,
  onSelect,
}: {
  items: SandboxTemplate[];
  activeSlug: string;
  selectedSlug: string | null;
  onSelect: (slug: string | null) => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const active = items.find((t) => t.slug === activeSlug) ?? items[0] ?? null;
  if (!active) return null;
  const d = describeSandboxTemplate(active);
  return (
    <SandboxTemplateMenu
      items={items}
      selectedSlug={selectedSlug}
      resolvedSlug={activeSlug}
      inherit={{
        label: 'Agent environment',
        description: 'Uses the selected agent, project, or platform default.',
      }}
      onSelect={onSelect}
      trigger={
        <button
          type="button"
          aria-label={tI18nHardcoded.raw(
            'autoFeaturesCoWorkerProjectLayoutProjectHomeJsxAttrAria4acf4ecd',
          )}
          className="text-muted-foreground hover:text-foreground hover:bg-muted duration-fast inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors"
        >
          <d.Icon className="size-3.5 shrink-0" />
          <span className="max-w-[7rem] truncate">
            {selectedSlug ? active.name : 'Agent environment'}
          </span>
          <span className={cn('size-1.5 shrink-0 rounded-full', d.stateDot)} />
        </button>
      }
    />
  );
}
