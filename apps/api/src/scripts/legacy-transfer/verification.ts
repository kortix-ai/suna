/** File completion requires positive capture and restore evidence, including empty workspaces. */
export function assertWorkspaceVerified(projectId: string, proof: {
  workspace_status?: string;
  source_sandbox_id?: string | null;
  workspace_capture?: { archive_sha256?: string; entries?: number; files?: number };
  workspace_restore?: { restored_entries?: number; regular_files?: number; metadata_verified?: boolean; root_directory_verified?: boolean; exact_inventory_verified?: boolean; file_hashes_verified?: boolean; target?: string };
}): void {
  const capture = proof.workspace_capture;
  const restore = proof.workspace_restore;
  if (proof.workspace_status !== 'captured' || !proof.source_sandbox_id || !capture || !restore) {
    throw new Error('Workspace is unresolved: capture and restore evidence are required');
  }
  if (!/^[a-f0-9]{64}$/.test(capture.archive_sha256 ?? '') ||
      !Number.isInteger(capture.entries) || capture.entries! < 1 ||
      !Number.isInteger(capture.files) || capture.files! < 0 ||
      restore.restored_entries !== capture.entries || restore.regular_files !== capture.files ||
      capture.files! >= capture.entries! ||
      restore.root_directory_verified !== true || restore.exact_inventory_verified !== true ||
      restore.file_hashes_verified !== true || restore.metadata_verified !== true || restore.target !== `/workspace/${projectId}`) {
    throw new Error('Workspace verification evidence does not match the source capture');
  }
}
