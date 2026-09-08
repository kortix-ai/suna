/**
 * S0.4 — a durable session store the worker does not own.
 *
 * THE REQUIREMENT, from the plan: history must be readable when nothing is
 * running. Today fetching messages means waking a box, waiting for the daemon,
 * waiting for OpenCode to listen, then calling an API built for a local editor.
 * That is the "session looks stopped, then a huge delay" class of bug.
 *
 * THE SHAPE. pi-agent-core's `SessionStorage` is a 20-method interface with
 * lane pointers, branch queries and open-operation recovery. Reimplementing
 * that against a network store would be reimplementing pi's tree semantics,
 * badly. So this decorates the in-memory implementation instead:
 *
 *   - every mutation is written through to an append-only remote log;
 *   - `restore()` replays that log into a fresh in-memory storage.
 *
 * pi keeps owning the tree. We own durability. The log is plain JSON entries,
 * so the control plane can render a transcript without pi in the picture at
 * all — which is P1.8, previewed.
 *
 * FIDELITY, STATED EXACTLY. The log is the source of truth and is byte-exact:
 * ids, order, message content, tool calls, tool results and original
 * timestamps all survive. Replay rebuilds the tree with the SAME ids in the
 * SAME order; `seq`/`parentId` are recomputed identically because the sequence
 * is identical, and `timestamp` is re-stamped because `appendEntry` owns it.
 * A reader that wants original timestamps reads the log, not the replayed
 * tree. Nothing about a conversation is lost; one derived field is refreshed.
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { InMemorySessionStorage } from '@earendil-works/pi-agent-core';
import { applyLegacyWireIdentities } from './legacy-wire-identity.ts';

export interface SessionLogLeaseFence {
  stream: string;
  messageId: string;
  ownerId: string;
  previousRevision: number;
}

export type StorageLogItem = (
  | { kind: 'entry'; lane: string; entry: any }
  | { kind: 'record'; record: any }
  | { kind: 'lane_create'; lane: string; at: string | null }
  | { kind: 'lane_move'; lane: string; to: string | null }
  | { kind: 'name'; name: string | undefined }
  | { kind: 'label'; id: string; label: string | undefined }
) & {
  /**
   * A storage mutation and its turn-owner lease transition share one remote
   * append. The deterministic append id makes this mutation compete with a
   * heartbeat or reclaim observed at the same lease revision.
   */
  _kortixTurnLease?: SessionLogLeaseFence;
};

export interface JournalLogItem {
  kind: 'journal';
  stream: string;
  record: Record<string, unknown>;
  _kortixTurnLease?: SessionLogLeaseFence;
}

export type SessionLogItem = (StorageLogItem | JournalLogItem) & {
  /** Persisted inside the item so a read can prove a timed-out append committed. */
  _kortixAppendId?: string;
};

export interface SessionLog {
  /** Reject an item before the caller commits any externally visible state. */
  preflight?(item: SessionLogItem): void;
  append(item: SessionLogItem, options?: { idempotencyKey?: string }): Promise<void>;
  read(): Promise<SessionLogItem[]>;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface RemoteSessionLogOptions {
  fetch?: FetchLike;
  createAppendId?: () => string;
  sleep?: (delayMs: number) => Promise<void>;
  maxAttempts?: number;
  requestTimeoutMs?: number;
}

const RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 4_000, 8_000] as const;
const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_SESSION_LOG_ITEM_BYTES = 512 * 1024;
const PREFLIGHT_APPEND_ID = '00000000-0000-4000-8000-000000000000';

function persistedItemSize(item: SessionLogItem, appendId: string): number {
  return Buffer.byteLength(JSON.stringify({ ...item, _kortixAppendId: appendId }), 'utf8');
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export class SessionLogReadUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionLogReadUnavailableError';
  }
}

export class SessionLogUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionLogUnavailableError';
  }
}

export class SessionLogItemTooLargeError extends Error {
  readonly sizeBytes: number;

  constructor(sizeBytes: number) {
    super(`session log item is ${sizeBytes} bytes; maximum is ${MAX_SESSION_LOG_ITEM_BYTES}`);
    this.name = 'SessionLogItemTooLargeError';
    this.sizeBytes = sizeBytes;
  }
}

export class SessionLogConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionLogConflictError';
  }
}

/** Append-only log over HTTP. Stands in for the Kortix control plane. */
export class RemoteSessionLog implements SessionLog {
  private failure: SessionLogUnavailableError | null = null;
  private readonly pendingAppends = new Map<string, SessionLogItem>();
  private recoveryBlocked = false;
  private recovery: Promise<boolean> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly sessionId: string,
    private readonly headers: Record<string, string> = {},
    private readonly options: RemoteSessionLogOptions = {},
  ) {}

  get error(): SessionLogUnavailableError | null {
    return this.failure;
  }

  get canRecoverPendingAppends(): boolean {
    return !this.recoveryBlocked && this.pendingAppends.size > 0;
  }

  recoverPendingAppends(): Promise<boolean> {
    if (this.recovery) return this.recovery;
    if (!this.failure) return Promise.resolve(true);
    if (!this.canRecoverPendingAppends) return Promise.resolve(false);
    const run = (async () => {
      for (const [idempotencyKey, item] of this.pendingAppends) {
        const replay = new RemoteSessionLog(this.baseUrl, this.sessionId, this.headers, this.options);
        try {
          await replay.append(item, { idempotencyKey });
          this.pendingAppends.delete(idempotencyKey);
        } catch (error) {
          if (!replay.canRecoverPendingAppends) {
            this.poison('session log recovery rejected the original pending append', error);
          }
          return false;
        }
      }
      if (this.recoveryBlocked) return false;
      this.failure = null;
      return true;
    })();
    this.recovery = run;
    void run.finally(() => { if (this.recovery === run) this.recovery = null; });
    return run;
  }

  assertWritable(): void {
    if (this.failure) throw this.failure;
  }

  preflight(item: SessionLogItem): void {
    this.assertWritable();
    const sizeBytes = persistedItemSize(item, PREFLIGHT_APPEND_ID);
    if (sizeBytes > MAX_SESSION_LOG_ITEM_BYTES) {
      throw new SessionLogItemTooLargeError(sizeBytes);
    }
  }

  private poison(
    message: string,
    cause: unknown,
    pending?: { id: string; item: SessionLogItem },
  ): SessionLogUnavailableError {
    if (pending) this.pendingAppends.set(pending.id, pending.item);
    else this.recoveryBlocked = true;
    if (!this.failure) this.failure = new SessionLogUnavailableError(message, { cause });
    return this.failure;
  }

  async append(
    item: SessionLogItem,
    appendOptions: { idempotencyKey?: string } = {},
  ): Promise<void> {
    this.assertWritable();
    const fetcher = this.options.fetch ?? globalThis.fetch;
    const sleep = this.options.sleep ?? defaultSleep;
    const maxAttempts = Math.max(1, this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const appendId = appendOptions.idempotencyKey ?? (this.options.createAppendId ?? randomUUID)();
    const headers = new Headers({ 'content-type': 'application/json', ...this.headers });
    headers.set('idempotency-key', appendId);
    const body = JSON.stringify({ ...item, _kortixAppendId: appendId });
    const persistedItem = JSON.parse(body) as SessionLogItem;
    const sizeBytes = Buffer.byteLength(body, 'utf8');
    if (sizeBytes > MAX_SESSION_LOG_ITEM_BYTES) {
      const error = new SessionLogItemTooLargeError(sizeBytes);
      throw this.poison(error.message, error);
    }
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const res = await fetcher(`${this.baseUrl}/sessions/${this.sessionId}/log`, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(
            Math.max(1, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
          ),
        });
        if (res.ok) return;
        if (res.status === 409) {
          throw new SessionLogConflictError('session log idempotency key has conflicting content');
        }
        const error = new Error(`session log append failed: HTTP ${res.status}`);
        if (!retryableStatus(res.status)) {
          throw this.poison(error.message, error);
        }
        lastError = error;
      } catch (error) {
        if (error instanceof SessionLogUnavailableError) throw error;
        if (error instanceof SessionLogConflictError) throw error;
        lastError = error;
      }

      if (attempt + 1 < maxAttempts) {
        await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!);
      }
    }

    const terminal = new Error(
      `session log append failed after ${maxAttempts} attempts: ${String(
        (lastError as Error)?.message ?? lastError,
      )}`,
    );
    let remote: SessionLogItem[];
    try {
      remote = await this.read();
    } catch (reconcileError) {
      throw this.poison(
        `${terminal.message}; reconciliation could not prove the append committed`,
        new AggregateError([terminal, reconcileError], 'session log append outcome is unresolved'),
        reconcileError instanceof SessionLogReadUnavailableError
          ? { id: appendId, item: persistedItem }
          : undefined,
      );
    }
    if (!Array.isArray(remote)) {
      const reconcileError = new TypeError('session log reconciliation response must be an array');
      throw this.poison(
        `${terminal.message}; reconciliation could not prove the append committed`,
        new AggregateError([terminal, reconcileError], 'session log append outcome is unresolved'),
      );
    }
    const committed = remote.find(
      (candidate) =>
        candidate !== null &&
        typeof candidate === 'object' &&
        candidate._kortixAppendId === appendId,
    );
    if (committed && isDeepStrictEqual(committed, persistedItem)) return;
    if (committed) {
      throw new SessionLogConflictError(
        `session log append id ${appendId} has conflicting persisted content`,
      );
    }
    const reconcileError = new Error(`append id ${appendId} is absent from the remote log`);
    throw this.poison(
      `${terminal.message}; reconciliation could not prove the append committed`,
      new AggregateError([terminal, reconcileError], 'session log append outcome is unresolved'),
      { id: appendId, item: persistedItem },
    );
  }

  async read(): Promise<SessionLogItem[]> {
    const fetcher = this.options.fetch ?? globalThis.fetch;
    const sleep = this.options.sleep ?? defaultSleep;
    const maxAttempts = Math.max(1, this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const res = await fetcher(`${this.baseUrl}/sessions/${this.sessionId}/log`, {
          headers: this.headers,
          signal: AbortSignal.timeout(
            Math.max(1, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
          ),
        });
        if (res.ok) return (await res.json()) as SessionLogItem[];
        const error = new Error(`session log read failed: HTTP ${res.status}`);
        if (!retryableStatus(res.status)) throw error;
        lastError = error;
      } catch (error) {
        lastError = error;
        if (error instanceof Error && error.message.startsWith('session log read failed: HTTP ')) {
          throw error;
        }
      }

      if (attempt + 1 < maxAttempts) {
        await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!);
      }
    }

    throw new SessionLogReadUnavailableError(
      `session log read failed after ${maxAttempts} attempts: ${String(
        (lastError as Error)?.message ?? lastError,
      )}`,
      { cause: lastError },
    );
  }
}

/**
 * Write-through decorator over InMemorySessionStorage.
 *
 * Reads are served entirely from memory — the remote store is never on the
 * read path of a running turn. Only mutations cross the network.
 */
export class DurableSessionStorage {
  private constructor(
    private readonly inner: InMemorySessionStorage,
    private readonly log: SessionLog,
    /** Suppressed while replaying, so restore does not re-write the log. */
    private replaying = false,
  ) {}

  static async open(
    metadata: any,
    log: SessionLog,
  ): Promise<{
    storage: DurableSessionStorage;
    restoredEntries: number;
    logItems: SessionLogItem[];
  }> {
    const inner = new InMemorySessionStorage(metadata);
    const durable = new DurableSessionStorage(inner, log, true);
    const items = await log.read();
    for (const item of applyLegacyWireIdentities(items, metadata.id)) {
      switch (item.kind) {
        case 'lane_create':
          await inner.createLane(item.lane, item.at);
          break;
        case 'lane_move':
          await inner.moveLane(item.lane, item.to);
          break;
        case 'entry': {
          // Strip the storage-owned fields; the id is ours and is preserved.
          const { parentId: _p, seq: _s, timestamp: _t, ...provisioned } = item.entry;
          await inner.appendEntry(provisioned as any, item.lane);
          break;
        }
        case 'record':
          await inner.appendRecord(item.record);
          break;
        case 'name':
          await inner.setName(item.name);
          break;
        case 'label':
          await inner.setLabel(item.id, item.label);
          break;
        case 'journal':
          break;
      }
    }
    durable.replaying = false;
    return {
      storage: durable,
      restoredEntries: items.filter((i) => i.kind === 'entry').length,
      logItems: items,
    };
  }

  private async write(item: StorageLogItem): Promise<void> {
    if (!this.replaying) await this.log.append(item);
  }

  // ---- mutations: write through -------------------------------------------
  async appendEntry(entry: any, lane: string) {
    const stored = await this.inner.appendEntry(entry, lane);
    await this.write({ kind: 'entry', lane, entry: stored });
    return stored;
  }
  async appendRecord(record: any) {
    const stored = await this.inner.appendRecord(record);
    await this.write({ kind: 'record', record: stored });
    return stored;
  }
  async createLane(lane: string, at: string | null) {
    await this.inner.createLane(lane, at);
    await this.write({ kind: 'lane_create', lane, at });
  }
  async moveLane(lane: string, to: string | null) {
    await this.inner.moveLane(lane, to);
    await this.write({ kind: 'lane_move', lane, to });
  }
  async setName(name: string | undefined) {
    await this.inner.setName(name);
    await this.write({ kind: 'name', name });
  }
  async setLabel(id: string, label: string | undefined) {
    await this.inner.setLabel(id, label);
    await this.write({ kind: 'label', id, label });
  }

  // ---- reads: straight through, never touch the network --------------------
  getMetadata() {
    return this.inner.getMetadata();
  }
  getLanes() {
    return this.inner.getLanes();
  }
  getEntry(id: string) {
    return this.inner.getEntry(id);
  }
  findEntries(q?: any) {
    return this.inner.findEntries(q);
  }
  findEntriesOnBranch(q: any) {
    return this.inner.findEntriesOnBranch(q);
  }
  findRecords(q?: any) {
    return (this.inner as any).findRecords(q);
  }
  findOpenOperations(lane: string, o?: any) {
    return this.inner.findOpenOperations(lane, o);
  }
  getLog(o?: any) {
    return this.inner.getLog(o);
  }
  getName() {
    return this.inner.getName();
  }
  getLabel(id: string) {
    return this.inner.getLabel(id);
  }
  getStats() {
    return this.inner.getStats();
  }
}
