export type FilesRightPanel = 'history' | 'proposed-changes' | null;

export function requestedFilesRightPanel(value: string | null): FilesRightPanel {
  return value === 'history' || value === 'proposed-changes' ? value : null;
}
