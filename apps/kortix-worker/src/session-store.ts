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
import { InMemorySessionStorage } from '@earendil-works/pi-agent-core';

type LogItem =
  | { kind: 'entry'; lane: string; entry: any }
  | { kind: 'record'; record: any }
  | { kind: 'lane_create'; lane: string; at: string | null }
  | { kind: 'lane_move'; lane: string; to: string | null }
  | { kind: 'name'; name: string | undefined }
  | { kind: 'label'; id: string; label: string | undefined };

export interface SessionLog {
  append(item: LogItem): Promise<void>;
  read(): Promise<LogItem[]>;
}

/** Append-only log over HTTP. Stands in for the Kortix control plane. */
export class RemoteSessionLog implements SessionLog {
  constructor(
    private readonly baseUrl: string,
    private readonly sessionId: string,
    private readonly headers: Record<string, string> = {},
  ) {}

  async append(item: LogItem): Promise<void> {
    // Fire-and-await: a lost append is a lost message, which is the one thing
    // this exists to prevent. Failures propagate rather than being swallowed.
    const res = await fetch(`${this.baseUrl}/sessions/${this.sessionId}/log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers },
      body: JSON.stringify(item),
    });
    if (!res.ok) throw new Error(`session log append failed: HTTP ${res.status}`);
  }

  async read(): Promise<LogItem[]> {
    const res = await fetch(`${this.baseUrl}/sessions/${this.sessionId}/log`, { headers: this.headers });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`session log read failed: HTTP ${res.status}`);
    return (await res.json()) as LogItem[];
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

  static async open(metadata: any, log: SessionLog): Promise<{ storage: DurableSessionStorage; restoredEntries: number }> {
    const inner = new InMemorySessionStorage(metadata);
    const durable = new DurableSessionStorage(inner, log, true);
    const items = await log.read();
    for (const item of items) {
      switch (item.kind) {
        case 'lane_create': await inner.createLane(item.lane, item.at); break;
        case 'lane_move': await inner.moveLane(item.lane, item.to); break;
        case 'entry': {
          // Strip the storage-owned fields; the id is ours and is preserved.
          const { parentId: _p, seq: _s, timestamp: _t, ...provisioned } = item.entry;
          await inner.appendEntry(provisioned as any, item.lane);
          break;
        }
        case 'record': await inner.appendRecord(item.record); break;
        case 'name': await inner.setName(item.name); break;
        case 'label': await inner.setLabel(item.id, item.label); break;
      }
    }
    durable.replaying = false;
    return { storage: durable, restoredEntries: items.filter((i) => i.kind === 'entry').length };
  }

  private async write(item: LogItem): Promise<void> {
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
  getMetadata() { return this.inner.getMetadata(); }
  getLanes() { return this.inner.getLanes(); }
  getEntry(id: string) { return this.inner.getEntry(id); }
  findEntries(q?: any) { return this.inner.findEntries(q); }
  findEntriesOnBranch(q: any) { return this.inner.findEntriesOnBranch(q); }
  findRecords(q?: any) { return (this.inner as any).findRecords(q); }
  findOpenOperations(lane: string, o?: any) { return this.inner.findOpenOperations(lane, o); }
  getLog(o?: any) { return this.inner.getLog(o); }
  getName() { return this.inner.getName(); }
  getLabel(id: string) { return this.inner.getLabel(id); }
  getStats() { return this.inner.getStats(); }
}
