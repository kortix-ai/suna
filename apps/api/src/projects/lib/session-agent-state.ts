import { HTTPException } from 'hono/http-exception';
import {
  PI_STATE_STREAM,
  validatePiStateName,
  validatePiStateSnapshot,
} from '../../../../../packages/sdk/src/core/pi/state';
import { PiStateConflictError } from '../../../../../packages/sdk/src/core/pi/agent';

export function validateAgentStateAppend(previous: Record<string, any>[], value: unknown): void {
  const item = value as Record<string, any>;
  try {
    if (
      !item ||
      item.kind !== 'journal' ||
      item.stream !== PI_STATE_STREAM ||
      !item.record ||
      Object.keys(item.record).some(
        (key) => !['namespace', 'revision', 'schemaVersion', 'value'].includes(key),
      )
    )
      throw new Error('invalid agent state record');
    validatePiStateName(item.record.namespace);
    validatePiStateSnapshot(item.record);
  } catch (error) {
    throw new HTTPException(error instanceof RangeError ? 413 : 400, {
      message: String((error as Error).message),
    });
  }
  const states = previous.filter(
    (entry) => entry.kind === 'journal' && entry.stream === PI_STATE_STREAM,
  );
  if (
    states.length >= 4096 ||
    Buffer.byteLength(JSON.stringify(states), 'utf8') +
      Buffer.byteLength(JSON.stringify(item), 'utf8') >
      16 * 1024 * 1024
  )
    throw new HTTPException(413, {
      message: 'Pi state history limit reached (4096 writes or 16 MiB)',
    });
  const namespaces = new Set(states.map((entry) => entry.record.namespace));
  const namespace = item.record.namespace;
  if (!namespaces.has(namespace) && namespaces.size >= 128)
    throw new HTTPException(413, { message: 'Pi state namespace limit reached (128)' });
  let current: Record<string, any> | undefined;
  for (const entry of states) if (entry.record.namespace === namespace) current = entry.record;
  if (item.record.revision !== (current?.revision ?? 0) + 1) throw new PiStateConflictError();
  if (item.record.schemaVersion < (current?.schemaVersion ?? 0))
    throw new HTTPException(409, { message: 'Pi state schema cannot be downgraded' });
}
