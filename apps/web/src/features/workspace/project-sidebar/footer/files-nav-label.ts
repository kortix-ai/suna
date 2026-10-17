import { capabilityTabHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';

/**
 * What the sidebar calls the repo browser. With the project's Volumes flag
 * on, Files is the project drive and the repo browser is Repo.
 * With Volumes off, the repo browser is Files, as it was before volumes.
 * Volumes reaches the client as the project's derived `drives` flag.
 */
export type RepoNavLabel = 'files' | 'repo';

export function repoNavLabel(volumesOn: boolean): RepoNavLabel {
  return volumesOn ? 'repo' : 'files';
}


/**
 * Label and destination of the sidebar's Files row for what it opens
 * (`useProjectNavRows().files`): the repo browser, or the shared folders for a
 * caller who cannot read the repo.
 */
export function filesRow(
  projectId: string,
  target: 'repo' | 'folders',
  volumesOn: boolean,
): { label: RepoNavLabel; href: string } {
  return target === 'folders'
    ? { label: 'files', href: capabilityTabHref(projectId, 'files') }
    : { label: repoNavLabel(volumesOn), href: `/projects/${projectId}/files` };
}
