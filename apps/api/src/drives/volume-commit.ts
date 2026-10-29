export interface VolumeWriteCommit {
  commit_id: string;
  outcome: 'fast' | 'merged' | 'queued' | 'noop';
  head_commit_id?: string;
}

export function parseVolumeWriteCommit(value: unknown): VolumeWriteCommit | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.commit_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.commit_id)
    || !['fast', 'merged', 'queued', 'noop'].includes(String(row.outcome))) return undefined;
  return {
    commit_id: row.commit_id,
    outcome: row.outcome as VolumeWriteCommit['outcome'],
    ...(typeof row.head_commit_id === 'string' ? { head_commit_id: row.head_commit_id } : {}),
  };
}
