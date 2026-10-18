'use client';

import { useTranslations } from '@/i18n/use-translations';
import { ReviewView } from '@/features/workspace/customize/sections/view/review-view';
import { receivedDenial } from '@/lib/use-project-can';
import { CapabilitiesSkeleton } from '@/features/workspace/capabilities/shared/capability-skeleton';
import { repoNavLabel } from '@/features/workspace/project-sidebar/footer/files-nav-label';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { ErrorState } from '@/features/layout/section/error-state';
import { useProjectPageCans, type CanResult } from '@/lib/use-project-can';
import { useFeatureFlag } from '@kortix/sdk/react';

import { ProjectFilesView } from './project-files-view';
import { ProjectPageHeader } from './project-page-header';

/** The two sections of the merged Repo page. */
export type RepoPageSection = 'repo' | 'review';

/**
 * Resolve only settled grants — the trunk `receivedDenial` rule (from
 * `@/lib/use-project-can`): a probe in flight or a failed probe is never a
 * denial. The repo body opens on a settled `project.file.read`; a settled
 * refusal falls through to the review section, which opens only on settled
 * read AND act grants. `error` is reserved for a failed probe, `denied` for a
 * settled refusal.
 */
export function repoPageSection(
  section: RepoPageSection,
  files: CanResult,
  reviewRead: CanResult,
  reviewAct: CanResult,
): RepoPageSection | 'loading' | 'error' | 'denied' {
  if (section === 'repo' && !receivedDenial(files)) {
    if (files.isError) return 'error';
    if (files.isLoading) return 'loading';
    return 'repo';
  }
  if (reviewRead.isError || reviewAct.isError) return 'error';
  if (reviewRead.isLoading || reviewAct.isLoading) return 'loading';
  return reviewRead.allowed && reviewAct.allowed ? 'review' : 'denied';
}

export interface RepoPageTab {
  key: RepoPageSection;
  label: string;
  href: string;
  active: boolean;
}

export function repoPageTabs(input: {
  projectId: string;
  section: RepoPageSection;
  repoOpen: boolean;
  reviewOpen: boolean;
  repoLabel: string;
  reviewLabel: string;
}): RepoPageTab[] {
  const base = `/projects/${input.projectId}/files`;
  const tabs: RepoPageTab[] = [];
  if (input.repoOpen) {
    tabs.push({
      key: 'repo',
      label: input.repoLabel,
      href: base,
      active: input.section === 'repo',
    });
  }
  if (input.reviewOpen) tabs.push({
    key: 'review',
    label: input.reviewLabel,
    href: `${base}/review`,
    active: input.section === 'review',
  });
  return tabs;
}

/**
 * `/projects/[id]/files` — the merged Repo page (KRTX-2444): one git-focused
 * surface holding the repo file browser and, as its own section, the Review
 * Center inbox. Review used to be a standalone project page
 * (`/projects/[id]/review`, the sidebar's own Review row); both now live here
 * and the old addresses redirect into the review section. The section switch
 * sits in the page header, in the `CapabilityTabs` underline style.
 *
 * The page carries the sidebar's needs-you badge on the Repo row
 * (`project-files-nav.tsx`), which lists for a review-only viewer for exactly
 * this page.
 */
export function ProjectRepoPage({
  projectId,
  section,
}: {
  projectId: string;
  section: RepoPageSection;
}) {
  const t = useTranslations('sidebar');
  // Shared machine-extracted catalog: the state titles reuse exact existing
  // strings, translated in every locale (`hardcodedUi.i18nComplete`).
  const tState = useTranslations('hardcodedUi.i18nComplete');
  const volumes = useFeatureFlag(projectId, 'drives');
  const repoLabel = repoNavLabel(volumes.enabled);
  const cans = useProjectPageCans(projectId);
  const files = cans[PROJECT_ACTIONS.PROJECT_FILE_READ];
  const reviewRead = cans[PROJECT_ACTIONS.PROJECT_REVIEW_READ];
  const reviewAct = cans[PROJECT_ACTIONS.PROJECT_REVIEW_ACT];
  const active = repoPageSection(section, files, reviewRead, reviewAct);

  // While the probes settle, the same shared chrome the trunk permission gate
  // (`CapabilityAccessGate`) renders — not a files-specific skeleton.
  if (active === 'loading') return <CapabilitiesSkeleton />;
  if (active === 'error') return <ErrorState title={tState.raw('textff42d4eadd12')} />;
  if (active === 'denied') return <ErrorState title={tState.raw('textabb84be05cfa')} />;

  const tabs = repoPageTabs({
    projectId,
    section: active,
    repoOpen: files.allowed && !files.isLoading && !files.isError,
    reviewOpen: reviewRead.allowed && reviewAct.allowed
      && !reviewRead.isLoading && !reviewAct.isLoading
      && !reviewRead.isError && !reviewAct.isError,
    repoLabel: t(repoLabel),
    reviewLabel: t('review'),
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {active === 'review' && (
        <ProjectPageHeader title={t('review')} tabs={tabs} />
      )}
      <div className="min-h-0 flex-1">
        {active === 'repo' ? <ProjectFilesView projectId={projectId} tabs={tabs} /> : <ReviewView projectId={projectId} />}
      </div>
    </div>
  );
}
