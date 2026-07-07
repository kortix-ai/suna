/**
 * Platform API client — sandbox backup API.
 */

export interface BackupInfo {
  id: string;
  description: string;
  created: string;
  size: number;
  status: string;
}

export interface BackupListResponse {
  backups: BackupInfo[];
  backups_enabled: boolean;
}

export async function listBackups(sandboxId: string): Promise<BackupListResponse> {
  throw new Error('Backups are not exposed for project-session sandboxes');
}

export async function createBackup(
  sandboxId: string,
  description?: string,
): Promise<{ backup_id: string; status: string }> {
  throw new Error('Backups are not exposed for project-session sandboxes');
}

export async function restoreBackup(
  sandboxId: string,
  backupId: string,
): Promise<void> {
  throw new Error('Backups are not exposed for project-session sandboxes');
}

export async function deleteBackup(
  sandboxId: string,
  backupId: string,
): Promise<void> {
  throw new Error('Backups are not exposed for project-session sandboxes');
}
