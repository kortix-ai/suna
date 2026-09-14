const TURN_STREAM = 'kortix.pi.turn-admission.v1';

export type PiHistorySelection = {
  kind: 'history';
  version: 1;
  revision: number;
} & (
  | {
      action: 'stage';
      messageId: string;
      fromLeaf: string | null;
      toLeaf: string | null;
      hiddenMessageIds: string[];
    }
  | { action: 'restore' }
);

export interface PiHistoryWorkspaceMove {
  operationId: string;
  environmentId: string;
  from: string;
  to: string;
}
export type PiHistoryTransition = PiHistorySelection | {
  kind: 'history'; version: 1; revision: number; operationId: string;
} & (
  | { action: 'prepare'; selection: PiHistorySelection; workspace: PiHistoryWorkspaceMove | null }
  | { action: 'commit' }
  | { action: 'cancel' }
);
type PreparedHistory = Extract<PiHistoryTransition, { action: 'prepare' }>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

export interface PiHistoryProjection {
  revision: number;
  hasHistory: boolean;
  pending: PreparedHistory | null;
  operationIds: Set<string>;
  staged: {
    messageId: string;
    originalLeaf: string | null;
    leaf: string | null;
    hiddenMessageIds: Set<string>;
    workspaceMoves: PiHistoryWorkspaceMove[];
  } | null;
  hiddenMessageIds: Set<string>;
  unfinishedTurnIds: Set<string>;
  laneMoves: Array<{ index: number; from: string | null; to: string | null; action?: 'stage' | 'restore' }>;
}

export class PiHistoryTransitionError extends Error {
  constructor(message: string, readonly status: 400 | 409 = 409) {
    super(message);
    this.name = 'PiHistoryTransitionError';
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function identity(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function leaf(value: unknown): value is string | null {
  return value === null || identity(value);
}

function parseTransition(value: unknown): PiHistoryTransition {
  const event = object(value);
  if (
    !event || event.kind !== 'history' || event.version !== 1 ||
    !Number.isSafeInteger(event.revision) || (event.revision as number) < 0
  ) throw new PiHistoryTransitionError('invalid history transition', 400);
  if (event.action === 'prepare' || event.action === 'commit' || event.action === 'cancel') {
    if (typeof event.operationId !== 'string' || !UUID.test(event.operationId)) throw new PiHistoryTransitionError('invalid history operation identity', 400);
    const base = { kind: 'history' as const, version: 1 as const, revision: event.revision as number, operationId: event.operationId };
    if (event.action !== 'prepare') return { ...base, action: event.action };
    if (!['stage', 'restore'].includes(String(object(event.selection)?.action))) throw new PiHistoryTransitionError('invalid prepared history selection', 400);
    const selection = parseTransition(event.selection) as PiHistorySelection;
    if (selection.revision !== base.revision) throw new PiHistoryTransitionError('prepared history revision changed', 400);
    const workspace = object(event.workspace);
    if (event.workspace !== null && (!workspace || workspace.operationId !== base.operationId || !identity(workspace.environmentId) || workspace.environmentId.length > 512 || typeof workspace.from !== 'string' || !HASH.test(workspace.from) || typeof workspace.to !== 'string' || !HASH.test(workspace.to))) {
      throw new PiHistoryTransitionError('invalid history workspace identity', 400);
    }
    return { ...base, action: 'prepare', selection, workspace: workspace ? { operationId: base.operationId, environmentId: workspace.environmentId as string, from: workspace.from as string, to: workspace.to as string } : null };
  }
  if (event.action !== 'stage' && event.action !== 'restore') throw new PiHistoryTransitionError('invalid history action', 400);
  if (event.action === 'restore') {
    return { kind: 'history', version: 1, revision: event.revision as number, action: 'restore' };
  }
  if (
    !identity(event.messageId) || !leaf(event.fromLeaf) || !leaf(event.toLeaf) ||
    !Array.isArray(event.hiddenMessageIds) || !event.hiddenMessageIds.every(identity) ||
    !event.hiddenMessageIds.includes(event.messageId) ||
    new Set(event.hiddenMessageIds).size !== event.hiddenMessageIds.length
  ) throw new PiHistoryTransitionError('invalid history branch or message identities', 400);
  return {
    kind: 'history', version: 1, revision: event.revision as number, action: 'stage',
    messageId: event.messageId, fromLeaf: event.fromLeaf, toLeaf: event.toLeaf,
    hiddenMessageIds: [...event.hiddenMessageIds],
  };
}

function validate(state: PiHistoryProjection, event: PiHistoryTransition): void {
  if (event.revision !== state.revision) {
    throw new PiHistoryTransitionError('history revision changed');
  }
  if (event.action === 'commit' || event.action === 'cancel') {
    if (!state.pending || state.pending.operationId !== event.operationId) throw new PiHistoryTransitionError('history operation identity changed');
    return;
  }
  if (state.pending) throw new PiHistoryTransitionError('history recovery is pending');
  if (event.action === 'prepare') {
    if (state.operationIds.has(event.operationId)) throw new PiHistoryTransitionError('history operation identity already used');
    validate(state, event.selection);
    if (event.selection.action === 'restore' && state.staged!.workspaceMoves.length > 0 && !event.workspace) throw new PiHistoryTransitionError('restore requires a workspace move');
    if (event.workspace && state.staged?.workspaceMoves.some(move => move.environmentId !== event.workspace!.environmentId)) throw new PiHistoryTransitionError('history environment identity changed');
    return;
  }
  if (state.unfinishedTurnIds.size > 0) {
    throw new PiHistoryTransitionError('history has an unfinished turn');
  }
  if (event.action === 'restore') {
    if (!state.staged) throw new PiHistoryTransitionError('nothing to restore');
    return;
  }
  if (state.staged && event.fromLeaf !== state.staged.leaf) {
    throw new PiHistoryTransitionError('history no longer matches the current branch');
  }
  if (state.hiddenMessageIds.has(event.messageId)) {
    throw new PiHistoryTransitionError('rewind boundary is already hidden');
  }
  if (event.hiddenMessageIds.some(id =>
    state.hiddenMessageIds.has(id) && !state.staged?.hiddenMessageIds.has(id),
  )) throw new PiHistoryTransitionError('history cannot stage a committed hidden message');
}

function validateAdmissionRevision(state: PiHistoryProjection, revision: unknown): void {
  if (state.pending) throw new PiHistoryTransitionError('history recovery is pending');
  if (revision === undefined) {
    if (state.hasHistory) throw new PiHistoryTransitionError('admission history revision is required after rewind');
    return;
  }
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
    throw new PiHistoryTransitionError('invalid admission history revision', 400);
  }
  if (revision !== state.revision) throw new PiHistoryTransitionError('history revision changed');
}

export function projectPiHistory(items: readonly unknown[]): PiHistoryProjection {
  const state: PiHistoryProjection = {
    revision: 0, hasHistory: false, staged: null, pending: null, operationIds: new Set(),
    hiddenMessageIds: new Set(), unfinishedTurnIds: new Set(), laneMoves: [],
  };
  const accepted = new Set<string>();
  const transitions = new Map<string, string>();
  for (const [index, value] of items.entries()) {
    const item = object(value);
    if (!item) continue;
    if (item.kind === 'history') {
      let event = parseTransition(item);
      if (identity(item._kortixAppendId)) {
        const encoded = JSON.stringify(event);
        const previous = transitions.get(item._kortixAppendId);
        if (previous !== undefined) {
          if (previous !== encoded) throw new PiHistoryTransitionError('conflicting history append identity');
          continue;
        }
        transitions.set(item._kortixAppendId, encoded);
      }
      validate(state, event);
      state.hasHistory = true;
      state.revision++;
      if (event.action === 'prepare') {
        state.pending = event;
        state.operationIds.add(event.operationId);
        continue;
      }
      if (event.action === 'cancel') { state.pending = null; continue; }
      let workspace: PiHistoryWorkspaceMove | null = null;
      let coordinated = false;
      if (event.action === 'commit') {
        workspace = state.pending!.workspace;
        event = state.pending!.selection;
        state.pending = null;
        coordinated = true;
      }
      if (event.action === 'stage') {
        state.staged ??= {
          messageId: event.messageId, originalLeaf: event.fromLeaf,
          leaf: event.toLeaf, hiddenMessageIds: new Set(), workspaceMoves: [],
        };
        if (workspace) state.staged.workspaceMoves.push(workspace);
        state.staged.messageId = event.messageId;
        state.staged.leaf = event.toLeaf;
        for (const id of event.hiddenMessageIds) {
          state.staged.hiddenMessageIds.add(id);
          state.hiddenMessageIds.add(id);
        }
        state.laneMoves.push({ index, from: event.fromLeaf, to: event.toLeaf, ...(coordinated ? { action: 'stage' as const } : {}) });
      } else {
        const staged = state.staged!;
        for (const id of staged.hiddenMessageIds) state.hiddenMessageIds.delete(id);
        state.laneMoves.push({ index, from: staged.leaf, to: staged.originalLeaf, ...(coordinated ? { action: 'restore' as const } : {}) });
        state.staged = null;
      }
      continue;
    }
    if (item.kind !== 'journal' || item.stream !== TURN_STREAM) continue;
    const record = object(item.record);
    if (!record) continue;
    if (record.type === 'accepted') {
      const id = object(record.turn)?.messageId;
      if (!identity(id) || accepted.has(id)) continue;
      validateAdmissionRevision(state, record.historyRevision);
      accepted.add(id);
      state.unfinishedTurnIds.add(id);
      state.revision++;
      state.staged = null;
    } else if (
      (record.type === 'completed' || record.type === 'cancelled') && identity(record.messageId)
    ) {
      state.unfinishedTurnIds.delete(record.messageId);
    }
  }
  return state;
}

export function validatePiHistoryTransition(
  items: readonly unknown[],
  value: unknown,
): PiHistoryTransition {
  const event = parseTransition(value);
  validate(projectPiHistory(items), event);
  return event;
}

export function isPiHistoryControlItem(value: unknown): boolean {
  const item = object(value);
  return item?.kind === 'history' || (
    item?.kind === 'journal' && item.stream === TURN_STREAM &&
    object(item.record)?.type === 'accepted'
  );
}

export function validatePiHistoryControlAppend(items: readonly unknown[], value: unknown): void {
  const item = object(value);
  if (item?.kind === 'history') {
    validatePiHistoryTransition(items, item);
    return;
  }
  if (!isPiHistoryControlItem(item)) return;
  validateAdmissionRevision(projectPiHistory(items), object(item!.record)?.historyRevision);
}
