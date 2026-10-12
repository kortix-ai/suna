/**
 * What the sidebar calls the repo browser. With Volumes on for the
 * organization, Files is the project drive and the repo browser is Repo.
 * With Volumes off, the repo browser is Files, as it was before volumes.
 * Volumes reaches the client as the project's derived `drives` flag.
 */
export type RepoNavLabel = 'files' | 'repo';

export function repoNavLabel(volumesOn: boolean): RepoNavLabel {
  return volumesOn ? 'repo' : 'files';
}

