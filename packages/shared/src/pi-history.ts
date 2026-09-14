const TURN_STREAM = 'kortix.pi.turn-admission.v1';

export type PiHistoryTransition = {
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

export interface PiHistoryProjection {
  revision: number;
  hasHistory: boolean;
  staged: {
    messageId: string;
    originalLeaf: string | null;
    leaf: string | null;
    hiddenMessageIds: Set<string>;
  } | null;
  hiddenMessageIds: Set<string>;
  unfinishedTurnIds: Set<string>;
  laneMoves: Array<{ index: number; from: string | null; to: string | null }>;
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
    !Number.isSafeInteger(event.revision) || (event.revision as number) < 0 ||
    (event.action !== 'stage' && event.action !== 'restore')
  ) throw new PiHistoryTransitionError('invalid history transition', 400);
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
    revision: 0, hasHistory: false, staged: null,
    hiddenMessageIds: new Set(), unfinishedTurnIds: new Set(), laneMoves: [],
  };
  const accepted = new Set<string>();
  const transitions = new Map<string, string>();
  for (const [index, value] of items.entries()) {
    const item = object(value);
    if (!item) continue;
    if (item.kind === 'history') {
      const event = parseTransition(item);
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
      if (event.action === 'stage') {
        state.staged ??= {
          messageId: event.messageId, originalLeaf: event.fromLeaf,
          leaf: event.toLeaf, hiddenMessageIds: new Set(),
        };
        state.staged.messageId = event.messageId;
        state.staged.leaf = event.toLeaf;
        for (const id of event.hiddenMessageIds) {
          state.staged.hiddenMessageIds.add(id);
          state.hiddenMessageIds.add(id);
        }
        state.laneMoves.push({ index, from: event.fromLeaf, to: event.toLeaf });
      } else {
        const staged = state.staged!;
        for (const id of staged.hiddenMessageIds) state.hiddenMessageIds.delete(id);
        state.laneMoves.push({ index, from: staged.leaf, to: staged.originalLeaf });
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
