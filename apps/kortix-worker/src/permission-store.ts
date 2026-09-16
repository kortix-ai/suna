import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PermissionApproval } from './permission-broker.ts';
import { validatePermissionRules, type PermissionRule } from './permission-policy.ts';
import type { SessionLog, SessionLogItem } from './session-store.ts';
import { sessionLogAppendId } from './session-log-id.ts';
import { TURN_JOURNAL_STREAM, TurnAdmissionJournal } from './turn-journal.ts';

const STREAM = 'kortix.pi.permission-approvals.v1';
export const SESSION_PERMISSION_STREAM = 'kortix.pi.session-permissions.v1';

export class PermissionApprovalStore {
  private grants = new Map<string, PermissionApproval>();
  private rules: PermissionRule[] = [];
  private epoch = '';
  private pending: Promise<unknown> = Promise.resolve();

  private constructor(private readonly log: SessionLog) {}

  static async open(
    log: SessionLog,
    items?: readonly SessionLogItem[],
  ): Promise<PermissionApprovalStore> {
    const store = new PermissionApprovalStore(log);
    store.restore(items ?? (await log.read()));
    return store;
  }

  private restore(items: readonly SessionLogItem[]): void {
    const journal = TurnAdmissionJournal.fromItems(this.log, items);
    const grants = new Map<string, PermissionApproval>();
    const seen = new Map<string, PermissionApproval>();
    const settings = new Map<string, PermissionRule[]>();
    const started = new Set<string>();
    let rules: PermissionRule[] = [];
    let epoch = '';
    for (const item of items) {
      if (item.kind !== 'journal') continue;
      if (item.stream === TURN_JOURNAL_STREAM && item.record.type === 'started') {
        const id = item.record.messageId as string;
        if (started.has(id)) continue;
        started.add(id);
        const tools = journal.admission(id)?.options.tools;
        if (tools === undefined) continue;
        if (!tools || typeof tools !== 'object' || Array.isArray(tools))
          throw new Error('invalid durable tool controls');
        if (Object.keys(tools).length) {
          if (
            Object.entries(tools).some(
              ([name, enabled]) => !name.trim() || typeof enabled !== 'boolean',
            )
          )
            throw new Error('invalid durable tool controls');
          rules = Object.entries(tools).map(([permission, enabled]) => ({
            permission,
            pattern: '*',
            action: enabled ? 'allow' : 'deny',
          }));
        }
      }
      if (item.stream === SESSION_PERMISSION_STREAM) {
        const id = item.record.id;
        if (typeof id !== 'string' || !id) throw new Error('invalid session permission identity');
        const next = validatePermissionRules(item.record.rules);
        if (settings.has(id)) {
          if (!isDeepStrictEqual(settings.get(id), next))
            throw new Error('conflicting session permission update');
          continue;
        }
        settings.set(id, next);
        rules = next;
        grants.clear();
        epoch = id;
      }
      if (item.stream !== STREAM) continue;
      const value = item.record as unknown as PermissionApproval & { epoch?: string };
      if (
        !value ||
        typeof value.requestId !== 'string' ||
        !value.requestId ||
        typeof value.permission !== 'string' ||
        !value.permission ||
        !Array.isArray(value.patterns) ||
        value.patterns.some((pattern) => typeof pattern !== 'string' || !pattern) ||
        (value.epoch !== undefined && typeof value.epoch !== 'string')
      ) {
        throw new Error('invalid durable permission approval');
      }
      const approval = {
        requestId: value.requestId,
        permission: value.permission,
        patterns: [...value.patterns],
      };
      const key = JSON.stringify([value.epoch ?? '', value.requestId]);
      const previous = seen.get(key);
      if (previous) {
        if (!isDeepStrictEqual(previous, approval))
          throw new Error('conflicting durable permission approval');
        continue;
      }
      seen.set(key, approval);
      if (value.epoch !== undefined && value.epoch !== epoch) continue;
      grants.set(value.requestId, approval);
    }
    this.grants = grants;
    this.rules = rules;
    this.epoch = epoch;
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.then(work);
    this.pending = result.catch(() => {});
    return result;
  }

  refresh(): Promise<void> {
    return this.serialized(async () => this.restore(await this.log.read()));
  }

  sessionRules(): PermissionRule[] {
    return structuredClone(this.rules);
  }

  approved(): PermissionApproval[] {
    return [...this.grants.values()].map((value) => structuredClone(value));
  }

  setRules(rules: readonly PermissionRule[]): Promise<void> {
    const copy = validatePermissionRules(rules);
    const id = randomUUID();
    return this.serialized(async () => {
      await this.log.append(
        { kind: 'journal', stream: SESSION_PERMISSION_STREAM, record: { id, rules: copy } },
        { idempotencyKey: sessionLogAppendId(`${SESSION_PERMISSION_STREAM}\0${id}`) },
      );
      this.restore(await this.log.read());
    });
  }

  save(approval: PermissionApproval): Promise<void> {
    const copy = structuredClone(approval);
    return this.serialized(async () => {
      this.restore(await this.log.read());
      const previous = this.grants.get(copy.requestId);
      if (previous) {
        if (!isDeepStrictEqual(previous, copy))
          throw new Error('conflicting durable permission approval');
        return;
      }
      const epoch = this.epoch;
      await this.log.append(
        { kind: 'journal', stream: STREAM, record: { ...copy, epoch } },
        {
          idempotencyKey: sessionLogAppendId(
            `${STREAM}\0${copy.requestId}${epoch ? `\0${epoch}` : ''}`,
          ),
        },
      );
      this.restore(await this.log.read());
    });
  }
}
