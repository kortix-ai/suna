/**
 * @kortix/ui/files — Browse and edit files. Project files are the git-backed repo
 * (`ProjectFilesProvider` + `DriveExplorer` / `FileExplorerPage`); sandbox files are a live
 * session's workspace (`SandboxFileExplorer`, needs a mounted `useSession`).
 */
export {
  saveDriveFile,
  useDismissDriveConflict,
  useDriveAvailability,
  useDriveConflicts,
  useDriveFolder,
  useFolderAccess,
  useFolderPrincipals,
  useInvalidateDrives,
  useProjectDrive,
  useShareFolder,
  useUnshareFolder,
} from './drives/use-drives';
export { FilePreviewDialog } from './file-preview-dialog';
export { FilePreviewHost } from './file-preview-host';
export { FilesStoreProvider, getFileIcon } from './project';
export { ChangeRequestDetailDialog } from './project/components/change-request-detail-dialog';
export { DiffRenderer } from './project/components/diff-renderer';
export { DriveExplorer } from './project/components/drive-explorer';
export { FileExplorerPage } from './project/components/file-explorer-page';
export { FileThumbnail } from './project/components/file-thumbnail';
export { ProjectFilesProvider, useProjectContext } from './project/context';
export {
  FileExplorerSourceProvider,
  type ExplorerQueryResult,
  type FileExplorerSource,
} from './project/explorer-source';
export { gitRefExplorerSource } from './project/git-ref-explorer-source';
export { useChangeRequestRecovery } from './project/hooks/use-change-request-recovery';
export {
  changeRequestKeys,
  openChangeRequestListQuery,
  useChangeRequestDiff,
  useChangeRequestMergePreview,
  useCloseChangeRequest,
  useMergeChangeRequest,
  useRequestChangesOnChangeRequest,
} from './project/hooks/use-change-requests';
export { useSelectedVersion } from './project/store/version-store';
export { workspaceFileSource } from './runtime/file-source';
export { useWorkspaceSearch } from './runtime/hooks/use-workspace-search';
export { SandboxFileExplorer } from './runtime/sandbox-file-explorer';
