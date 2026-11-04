'use client';

import { useProjectMemoryPages } from '@kortix/sdk/react';
import { BuildingsIcon, SunDimIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { useTranslations } from '../../i18n';
import { uiRoutes } from '../../lib/routes';
import { Button } from '../../primitives/button';
import { EmptyArt } from '../../primitives/empty-art';
import { EmptyState } from '../../primitives/empty-state';
import { UiLink } from '../../providers/ui-provider';

/**
 * A layer with no pages: the empty-folder layout of Files, with what memory
 * is in one sentence. `action` is "Remember this…" for a writer; a channel or
 * DM adds "Open Company memory", the layer its agent also reads.
 */
export function MemoryEmpty({
  projectId,
  kind,
  place,
  action,
}: {
  projectId: string;
  kind: 'company' | 'channel' | 'dm';
  /** "#marketing" or the DM's agent. */
  place: string;
  action?: ReactNode;
}) {
  const t = useTranslations('spaces.memory.empty');
  return (
    <EmptyState
      className="min-h-full"
      media={<EmptyArt icon={SunDimIcon} />}
      title={t(kind === 'dm' ? 'titleDm' : kind === 'company' ? 'titleCompany' : 'title', { place })}
      description={t('description')}
      action={action}
      secondaryAction={kind === 'company' ? undefined : <CompanyMemoryButton projectId={projectId} />}
    />
  );
}

/** "Open Company memory · 16 pages": hidden until the count loads. */
function CompanyMemoryButton({ projectId }: { projectId: string }) {
  const t = useTranslations('spaces.memory');
  const company = useProjectMemoryPages(projectId, 'company');
  const href = uiRoutes().memory(projectId);
  if (!href || !company.data) return null;
  return (
    <Button asChild variant="outline" size="sm" className="gap-1.5 tabular-nums" title={t('companyLinkHint')}>
      <UiLink href={href}>
        <BuildingsIcon className="size-3.5 shrink-0" />
        {t('empty.openCompany', { count: company.data.length })}
      </UiLink>
    </Button>
  );
}

