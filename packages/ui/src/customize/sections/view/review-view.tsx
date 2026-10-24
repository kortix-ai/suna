'use client';

import { ProjectFilesProvider } from '../../../files/project';
import { useTranslations } from '../../../i18n';
import { CustomizeHeader } from '../../agents/agent-page-chrome';
import { ReviewCenterConnected } from './review-center-connected';
import { useProjectName } from '@kortix/sdk/react';

/**
 * The Review Center inbox — the per-project human-in-the-loop inbox wired
 * to live data. On for every project. Each verdict shows only for a viewer
 * who holds the leaves its route asserts (`ReviewCenterConnected`, KRTX-1720).
 */
export function ReviewView({ projectId }: { projectId: string }) {
  // One source for the project name — see `useProjectName`'s doc comment.
  // Reads the SAME qk.project.detail(projectId) entry the legacy panel
  // already mounts whenever the panel is open (this view only renders while
  // that panel is open), so this is a cache hit, not a second `getProject`
  // request for data the parent already holds.
  const projectName = useProjectName(projectId) ?? '';

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <ProjectFilesProvider value={{ projectId, ref: '', defaultBranch: '' }}>
        <ReviewCenterConnected projectName={projectName} />
      </ProjectFilesProvider>
    </div>
  );
}

/**
 * /customize/review: the Review Center under the one Customize header
 * (`CustomizeHeader`), so its title sits where the Agents index, an agent and
 * My Kortix put theirs.
 */
export function ReviewPage({ projectId }: { projectId: string }) {
  const t = useTranslations('agentEditor.tabs');
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <CustomizeHeader title={t('review')} description={t('reviewLead')} rule />
      <ReviewView projectId={projectId} />
    </div>
  );
}
