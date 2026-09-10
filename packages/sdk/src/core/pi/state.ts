export type PiStateValue =
  | null
  | boolean
  | number
  | string
  | PiStateValue[]
  | { [key: string]: PiStateValue };

export interface PiStateSnapshot<T extends PiStateValue = PiStateValue> {
  readonly revision: number;
  readonly schemaVersion: number;
  readonly value: T;
}

export interface PiStateDefinition<T extends PiStateValue> {
  schemaVersion: number;
  initialValue: T;
  /** Pure migration from any supported older version. Can run again after a conflict. */
  migrate?: (previous: PiStateSnapshot) => T | Promise<T>;
}

export interface PiStateNamespace<T extends PiStateValue> {
  read(): Promise<PiStateSnapshot<T>>;
  /** Pure transformation. Can run up to eight times under concurrent updates. */
  update(transform: (value: T) => T | Promise<T>): Promise<PiStateSnapshot<T>>;
}

type WidenState<T extends PiStateValue> = T extends number
  ? number
  : T extends string
    ? string
    : T extends boolean
      ? boolean
      : T;

export interface PiAgentState {
  open<T extends PiStateValue>(
    name: string,
    definition: PiStateDefinition<T>,
  ): Promise<PiStateNamespace<WidenState<T>>>;
}

export class PiStateConflictError extends Error {
  readonly code = 'PI_STATE_CONFLICT';
  constructor() {
    super('Pi state revision changed; read the current state and retry');
    this.name = 'PiStateConflictError';
    Object.defineProperty(this, Symbol.for('kortix.pi.state-conflict'), { value: true });
  }

  static [Symbol.hasInstance](value: unknown): boolean {
    return (
      !!value &&
      typeof value === 'object' &&
      (value as Record<symbol, unknown>)[Symbol.for('kortix.pi.state-conflict')] === true
    );
  }
}

export const PI_STATE_STREAM = 'kortix.pi.agent-state.v1';
export const PI_STATE_MAX_VALUE_BYTES = 64 * 1024;

export function validatePiStateName(name: string): void {
  if (
    typeof name !== 'string' ||
    !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(name) ||
    ['__proto__', 'prototype', 'constructor'].includes(name)
  )
    throw new TypeError(
      'Pi state namespace must use 1–64 letters, digits, dots, underscores or hyphens, starting with a letter',
    );
}

export function copyPiStateValue<T extends PiStateValue>(value: T): T {
  const parents = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 20000 || depth > 64)
      throw new TypeError('Pi state JSON exceeds structural limits');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || parents.has(item))
      throw new TypeError('Pi state must contain finite, acyclic JSON values');
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null)
      throw new TypeError('Pi state must contain plain JSON objects');
    parents.add(item);
    const entries = Reflect.ownKeys(item);
    for (const key of entries) {
      if (Array.isArray(item) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor))
        throw new TypeError('Pi state cannot contain symbols, accessors or hidden properties');
      if (Array.isArray(item) && !/^(0|[1-9][0-9]*)$/.test(key))
        throw new TypeError('Pi state arrays cannot contain named properties');
      visit(descriptor.value, depth + 1);
    }
    if (Array.isArray(item) && entries.length - 1 !== item.length)
      throw new TypeError('Pi state arrays cannot contain holes');
    parents.delete(item);
  };
  visit(value, 0);
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).byteLength > PI_STATE_MAX_VALUE_BYTES)
    throw new RangeError(`Pi state value exceeds ${PI_STATE_MAX_VALUE_BYTES} bytes`);
  return JSON.parse(encoded) as T;
}

export function validatePiStateSnapshot(value: PiStateSnapshot): PiStateSnapshot {
  if (
    !value ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !Number.isSafeInteger(value.schemaVersion) ||
    value.schemaVersion < 1
  )
    throw new TypeError('Pi state revision and schemaVersion must be positive safe integers');
  return {
    revision: value.revision,
    schemaVersion: value.schemaVersion,
    value: copyPiStateValue(value.value),
  };
}

export function createPiAgentState(backend: {
  read(name: string): Promise<PiStateSnapshot | null>;
  write(name: string, next: PiStateSnapshot): Promise<void>;
}): PiAgentState {
  async function retry<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await work();
      } catch (error) {
        if (!(error instanceof PiStateConflictError) || attempt >= 7) throw error;
      }
    }
  }
  return Object.freeze({
    async open<T extends PiStateValue>(
      name: string,
      definition: PiStateDefinition<T>,
    ): Promise<PiStateNamespace<WidenState<T>>> {
      validatePiStateName(name);
      const version = definition?.schemaVersion;
      if (!Number.isSafeInteger(version) || version < 1)
        throw new TypeError('Pi state schemaVersion must be a positive safe integer');
      for (const key of Object.keys(definition))
        if (!['schemaVersion', 'initialValue', 'migrate'].includes(key))
          throw new TypeError(`Pi state setting ${key} is unsupported`);
      if (definition.migrate !== undefined && typeof definition.migrate !== 'function')
        throw new TypeError('Pi state migrate must be a function');
      const initial = copyPiStateValue(definition.initialValue);
      const migrate = definition.migrate;
      async function current(): Promise<PiStateSnapshot<WidenState<T>>> {
        const stored = await backend.read(name);
        const previous = stored ? validatePiStateSnapshot(stored) : null;
        if (previous && previous.schemaVersion > version)
          throw new Error(
            `Pi state ${name} uses newer schema ${previous.schemaVersion}; this code supports ${version}`,
          );
        if (previous?.schemaVersion === version) return previous as PiStateSnapshot<WidenState<T>>;
        if (previous && !migrate)
          throw new Error(
            `Pi state ${name} requires a migration from ${previous.schemaVersion} to ${version}`,
          );
        const next = validatePiStateSnapshot({
          revision: (previous?.revision ?? 0) + 1,
          schemaVersion: version,
          value: previous ? await migrate!(previous) : initial,
        });
        await backend.write(name, next);
        return next as PiStateSnapshot<WidenState<T>>;
      }
      await retry(current);
      return Object.freeze({
        read: () => retry(current),
        update: (transform: (value: WidenState<T>) => WidenState<T> | Promise<WidenState<T>>) =>
          retry(async () => {
            if (typeof transform !== 'function')
              throw new TypeError('Pi state update requires a function');
            const previous = await current();
            const next = validatePiStateSnapshot({
              revision: previous.revision + 1,
              schemaVersion: version,
              value: await transform(copyPiStateValue(previous.value)),
            });
            await backend.write(name, next);
            return next as PiStateSnapshot<WidenState<T>>;
          }),
      });
    },
  });
}
