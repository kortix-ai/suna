'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

import { useFeatureFlag } from '@kortix/sdk/react';
import { ReviewView } from '@kortix/ui/customize/sections/view/review-view';
import { useTranslations } from '@kortix/ui/i18n';
import { capabilityTabHref, ProjectPageHeader } from '@kortix/ui/workspace';

/**
 * /projects/[id]/review.
 *
 * Spaces on (`chat`): the Review Center on its own, in the main pane, beside
 * the Spaces sidebar (the sidebar's Review row). No Customize shell, no
 * settings nav: the existing Review content (`ReviewView`), unchanged.
 *
 * Spaces off: the address it was from 2026-10-02 to 2026-10-17. It redirects
 * to the Customize Review tab and keeps the query, so a shared
 * `?id=<review item id>` link still opens the same review.
 */
export default function ProjectReviewRoute() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const spaces = useFeatureFlag(id, 'chat');
  const t = useTranslations('agentEditor.tabs');

  useEffect(() => {
    if (spaces.isLoading || spaces.enabled) return;
    const query = searchParams.toString();
    const href = capabilityTabHref(id, 'review');
    router.replace(query ? `${href}?${query}` : href);
  }, [spaces.isLoading, spaces.enabled, id, searchParams, router]);

  if (!spaces.enabled) return null;
  return (
    <div className="bg-background flex min-h-0 flex-1 flex-col overflow-hidden">
      <ProjectPageHeader title={t('review')} />
      <ReviewView projectId={id} />
    </div>
  );
}
