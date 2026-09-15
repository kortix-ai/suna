export interface WorkspaceCheckpoint { snapshotId: string; files: number; bytes: number }
export interface WorkspaceHistoryMove { operationId: string; from: string; to: string }
export interface WorkspaceHistoryReceipt extends WorkspaceHistoryMove {
  status: 'applying' | 'complete' | 'cancelled';
  changedPaths: string[];
}
