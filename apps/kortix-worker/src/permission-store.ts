import { isDeepStrictEqual } from 'node:util';
import type { PermissionApproval } from './permission-broker.ts';
import type { SessionLog, SessionLogItem } from './session-store.ts';
import { sessionLogAppendId } from './session-log-id.ts';

const STREAM = 'kortix.pi.permission-approvals.v1';

export class PermissionApprovalStore {
  private readonly grants = new Map<string, PermissionApproval>();

  private constructor(private readonly log: SessionLog) {}

  static async open(
    log: SessionLog,
    items?: readonly SessionLogItem[],
  ): Promise<PermissionApprovalStore> {
    const store = new PermissionApprovalStore(log);
    for (const item of items ?? (await log.read())) {
      if (item.kind !== 'journal' || item.stream !== STREAM) continue;
      const value = item.record as unknown as PermissionApproval;
      if (
        !value ||
        typeof value.requestId !== 'string' ||
        !value.requestId ||
        typeof value.permission !== 'string' ||
        !value.permission ||
        !Array.isArray(value.patterns) ||
        value.patterns.some((pattern) => typeof pattern !== 'string' || !pattern)
      ) {
        throw new Error('invalid durable permission approval');
      }
      const previous = store.grants.get(value.requestId);
      if (previous && !isDeepStrictEqual(previous, value))
        throw new Error('conflicting durable permission approval');
      store.grants.set(value.requestId, structuredClone(value));
    }
    return store;
  }

  approved(): PermissionApproval[] {
    return [...this.grants.values()].map((value) => structuredClone(value));
  }

  async save(approval: PermissionApproval): Promise<void> {
    const copy = structuredClone(approval);
    const previous = this.grants.get(copy.requestId);
    if (previous) {
      if (!isDeepStrictEqual(previous, copy))
        throw new Error('conflicting durable permission approval');
      return;
    }
    await this.log.append(
      { kind: 'journal', stream: STREAM, record: { ...copy } },
      { idempotencyKey: sessionLogAppendId(`${STREAM}\0${copy.requestId}`) },
    );
    this.grants.set(copy.requestId, copy);
  }
}
