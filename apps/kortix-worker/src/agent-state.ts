import {
  createPiAgentState,
  PI_STATE_STREAM,
  validatePiStateSnapshot,
  type PiStateSnapshot,
} from '../../../packages/sdk/src/core/pi/state';
import type { SessionLog } from './session-store';

export function createAgentState(log?: SessionLog, getSignal?: () => AbortSignal) {
  const active = () => {
    getSignal?.().throwIfAborted();
    if (!log) throw new Error('Pi agent state requires durable session storage');
    return log;
  };
  return createPiAgentState({
    async read(namespace) {
      const items = await active().read();
      active();
      let current: PiStateSnapshot | null = null;
      for (const item of items) {
        if (
          item.kind !== 'journal' ||
          item.stream !== PI_STATE_STREAM ||
          item.record.namespace !== namespace
        )
          continue;
        const next = validatePiStateSnapshot(item.record as unknown as PiStateSnapshot);
        if (
          next.revision !== (current?.revision ?? 0) + 1 ||
          next.schemaVersion < (current?.schemaVersion ?? 0)
        )
          throw new Error(`Pi state ${namespace} has an invalid durable revision or schema`);
        current = next;
      }
      return current;
    },
    async write(namespace, next) {
      const store = active();
      const item = {
        kind: 'journal' as const,
        stream: PI_STATE_STREAM,
        record: { namespace, ...next },
      };
      store.preflight?.(item);
      await store.append(item);
    },
  });
}
