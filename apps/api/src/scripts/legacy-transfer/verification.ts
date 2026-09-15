/** File completion requires positive capture and restore evidence, including empty workspaces. */
export function assertWorkspaceVerified(projectId: string, proof: {
  workspace_status?: string;
  workspace_api_verified_files?: number;
  remote_archive_verified_at?: string;
  remote_archive_files?: number;
  source_sandbox_id?: string | null;
  workspace_capture?: { archive_sha256?: string; entries?: number; files?: number };
  workspace_restore?: { restored_entries?: number; regular_files?: number; metadata_verified?: boolean; root_directory_verified?: boolean; exact_inventory_verified?: boolean; file_hashes_verified?: boolean; target?: string };
}, expectedArchiveFiles = 6): void {
  const capture = proof.workspace_capture;
  const restore = proof.workspace_restore;
  if (proof.workspace_status !== 'captured' || !proof.source_sandbox_id || !capture || !restore ||
      !proof.remote_archive_verified_at || proof.remote_archive_files !== expectedArchiveFiles) {
    throw new Error('Workspace is unresolved: capture and restore evidence are required');
  }
  if (!/^[a-f0-9]{64}$/.test(capture.archive_sha256 ?? '') ||
      !Number.isInteger(capture.entries) || capture.entries! < 1 ||
      !Number.isInteger(capture.files) || capture.files! < 0 ||
      restore.restored_entries !== capture.entries || restore.regular_files !== capture.files ||
      proof.workspace_api_verified_files !== capture.files ||
      capture.files! >= capture.entries! ||
      restore.root_directory_verified !== true || restore.exact_inventory_verified !== true ||
      restore.file_hashes_verified !== true || restore.metadata_verified !== true || restore.target !== `/workspace/${projectId}`) {
    throw new Error('Workspace verification evidence does not match the source capture');
  }
}

/** An explicit missing-provider-box waiver verifies history without claiming files. */
export function assertApprovedMissingSandboxException(proof: {
  workspace_status?: string;
  source_sandbox_id?: string | null;
  approved_exception?: { source_project_id?: string; source_sandbox_id?: string; provider_http?: number; authorized_at?: string };
  remote_archive_files?: number;
  remote_archive_verified_at?: string;
  owner_verified?: boolean;
  marko_access_verified?: boolean;
  native_messages_verified?: boolean;
}): void {
  const exception = proof.approved_exception;
  if (proof.workspace_status !== 'approved-404-workspace-skip' || !exception ||
      !exception.source_project_id || !exception.source_sandbox_id ||
      exception.source_sandbox_id !== proof.source_sandbox_id ||
      exception.provider_http !== 404 || !exception.authorized_at ||
      proof.remote_archive_files !== 4 || !proof.remote_archive_verified_at ||
      proof.owner_verified !== true || proof.marko_access_verified !== true ||
      proof.native_messages_verified !== true) {
    throw new Error('Approved missing-sandbox history evidence is incomplete');
  }
}

/** A scoped missing-reference waiver verifies history without claiming files. */
export function assertApprovedNoReferenceWorkspaceException(projectId: string, proof: {
  workspace_status?: string;
  source_sandbox_id?: string | null;
  approved_exception?: { source_project_id?: string; reason?: string; authorized_at?: string; source_mapping_problems?: string[] };
  workspace_capture?: unknown;
  workspace_restore?: unknown;
  remote_archive_files?: number;
  remote_archive_verified_at?: string;
  owner_verified?: boolean;
  marko_access_verified?: boolean;
  native_messages_verified?: boolean;
}): void {
  const exception=proof.approved_exception;
  if(proof.workspace_status!=='approved-no-reference-workspace-skip'||proof.source_sandbox_id!=null||
     exception?.source_project_id!==projectId||exception.reason!=='missing-sandbox-reference'||
     !exception.authorized_at||exception.source_mapping_problems?.length!==1||
     exception.source_mapping_problems[0]!=='missing-sandbox-reference'||
     proof.workspace_capture!=null||proof.workspace_restore!=null||
     proof.remote_archive_files!==4||!proof.remote_archive_verified_at||
     proof.owner_verified!==true||proof.marko_access_verified!==true||
     proof.native_messages_verified!==true){
    throw new Error('Approved no-reference history evidence is incomplete');
  }
}
