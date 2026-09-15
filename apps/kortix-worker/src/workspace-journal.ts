import type { SessionLogItem } from './session-store';

export const WORKSPACE_JOURNAL = 'kortix.pi.workspace.v1';
export interface WorkspaceDelta { from: string; to: string }
export interface WorkspaceOperationEvent {
  phase: 'begin' | 'end';
  operationId: string;
  workspace?: WorkspaceDelta | null;
}
export type WorkspaceObserver = (event: WorkspaceOperationEvent) => Promise<boolean>;

export function workspaceJournalItem(record: Record<string, unknown>): SessionLogItem {
  return { kind: 'journal', stream: WORKSPACE_JOURNAL, record };
}

export function workspaceUndoPlan(items: readonly SessionLogItem[], messageIds: Set<string>): { environmentId: string; moves: WorkspaceDelta[] } | null {
  const covered = new Set<string>();
  const operations = new Map<string, { messageId: string; environmentId: string | null; workspace?: WorkspaceDelta | null }>();
  const finished: string[] = [];
  for (const item of items) {
    if (item.kind !== 'journal' || item.stream !== WORKSPACE_JOURNAL) continue;
    const record = item.record;
    if (typeof record.messageId !== 'string' || !messageIds.has(record.messageId)) continue;
    if (record.type === 'covered') { covered.add(record.messageId); continue; }
    const id = record.operationId;
    if (typeof id !== 'string') throw new Error('Invalid workspace operation identity');
    if (record.type === 'begin') {
      if (operations.has(id)) throw new Error('Duplicate workspace operation identity');
      operations.set(id, { messageId: record.messageId, environmentId: typeof record.environmentId === 'string' ? record.environmentId : null });
    } else if (record.type === 'end') {
      const operation = operations.get(id);
      if (!operation || operation.messageId !== record.messageId || operation.workspace !== undefined) throw new Error('Invalid workspace operation completion');
      const delta = record.workspace as WorkspaceDelta | null;
      if (delta && (!/^[a-f0-9]{64}$/.test(delta.from) || !/^[a-f0-9]{64}$/.test(delta.to))) throw new Error('Invalid workspace checkpoint identity');
      operation.workspace = delta;
      finished.push(id);
    }
  }
  if ([...messageIds].some(id => !covered.has(id))) throw new Error('This turn predates workspace recording. Rewind is unavailable for this turn.');
  if ([...operations.values()].some(op => !op.workspace || !op.environmentId)) throw new Error('This turn has an incomplete workspace record. Its files cannot be safely rewound.');
  const changing = finished.map(id => operations.get(id)!).filter(op => op.workspace!.from !== op.workspace!.to);
  const environments = new Set(changing.map(op => op.environmentId!));
  if (environments.size > 1) throw new Error('Rewind crosses an environment replacement. The original workspace is required.');
  if (!changing.length) return null;
  return { environmentId: changing[0]!.environmentId!, moves: changing.reverse().map(op => ({ from: op.workspace!.to, to: op.workspace!.from })) };
}
