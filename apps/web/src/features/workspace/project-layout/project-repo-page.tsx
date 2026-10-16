'use client';

import { useTranslations } from '@/i18n/use-translations';
import { ReviewView } from '@/features/workspace/customize/sections/view/review-view';
import { repoNavLabel } from '@/features/workspace/project-sidebar/footer/files-nav-label';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectPageCans } from '@/lib/use-project-can';
import { useFeatureFlag } from '@kortix/sdk/react';

import { ProjectFilesView } from './project-files-view';
import { ProjectPageHeader, type ProjectPageHeaderTab } from './project-page-header';

/** The two sections of the merged Repo page. */
export type RepoPageSection = 'repo' | 'review';

/**
 * The section whose body renders for the requested section and the repo-read
 * gate. The review inbox is open to every project member
 * (`project.review.read` is floor-tier) while the repo browser needs
 * `project.file.read` (editor-tier), so a viewer without the files read still
 * gets a working page: their body falls back to the review section instead of
 * the repo browser's own error state. The review section itself never falls
 * back — the inbox renders for anyone (each verdict gates its own controls).
 */
export function repoPageSection(section: RepoPageSection, repoOpen: boolean): RepoPageSection {
  if (section === 'review') return 'review';
  return repoOpen ? 'repo' : 'review';
}

export interface RepoPageTab {
  key: RepoPageSection;
  label: string;
  href: string;
  active: boolean;
}

/**
 * The sections the merged surface offers a viewer, in bar order. `section` is
 * the ACTIVE section (`repoPageSection`), so the tab that actually renders the
 * body lights up — including the review fallback a review-only viewer gets on
 * `/files`. `repoOpen` counts a probe in flight as open — optimistic, the
 * same rule the sidebar row uses — so the bar never flickers while
 * `/effective` answers.
 */
export function repoPageTabs(input: {
  projectId: string;
  section: RepoPageSection;
  repoOpen: boolean;
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
  tabs.push({
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
  const volumes = useFeatureFlag(projectId, 'drives');
  const repoLabel = repoNavLabel(volumes.enabled);
  const canReadFiles = useProjectPageCans(projectId)[PROJECT_ACTIONS.PROJECT_FILE_READ];
  // Optimistic while the probe loads: the repo section renders, same rule the
  // sidebar row follows (it only disappears on an explicit deny).
  const repoOpen = canReadFiles.allowed || canReadFiles.isLoading;

  const active = repoPageSection(section, repoOpen);
  const tabs = repoPageTabs({
    projectId,
    section: active,
    repoOpen,
    repoLabel: t(repoLabel),
    reviewLabel: t('review'),
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ProjectPageHeader
        title={active === 'repo' ? t(repoLabel) : t('review')}
        tabs={tabs.length > 1 ? tabs : undefined}
      />
      <div className="min-h-0 flex-1">
        {active === 'repo' ? <ProjectFilesView projectId={projectId} /> : <ReviewView projectId={projectId} />}
      </div>
    </div>
  );
}
