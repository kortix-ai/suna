/**
 * What the sidebar's file row is called. With the project's Volumes flag on
 * it is Drive, the shared folders, and the repo browser moves to Customize →
 * Repo (admins only). With Volumes off it is Files, the repo browser, as it
 * was before volumes. Volumes reaches the client as the derived `drives` flag.
 */
export type FilesNavLabel = 'files' | 'drive';

export function filesNavLabel(volumesOn: boolean): FilesNavLabel {
  return volumesOn ? 'drive' : 'files';
}

/** Label and destination of the row `useProjectNavRows().files` decided. */
export function filesRow(
  projectId: string,
  target: 'repo' | 'drive',
): { label: FilesNavLabel; href: string } {
  const drive = target === 'drive';
  return {
    label: filesNavLabel(drive),
    href: `/projects/${projectId}/${drive ? 'drive' : 'files'}`,
  };
}
