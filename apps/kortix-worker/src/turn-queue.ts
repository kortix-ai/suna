export type TurnQueueState = 'queued' | 'running' | 'missing';
export type TurnCancelOutcome = 'cancelled' | 'running' | 'missing';
export type TurnCompletion = 'completed' | 'cancelled' | 'interrupted';

export interface TurnQueueOptions<T> {
  id(turn: T): string;
  run(turn: T): Promise<TurnCompletion | undefined> | Promise<void>;
  onAccepted?(turn: T): void;
}

interface TurnEntry<T> {
  id: string;
  turn: T;
  state: Exclude<TurnQueueState, 'missing'>;
  done: Promise<TurnCompletion>;
  resolve: (outcome: TurnCompletion) => void;
  reject: (error: unknown) => void;
}

/**
 * One serial queue for one Pi conversation.
 *
 * Admission is synchronous. `onAccepted` runs before `enqueue` returns, so the
 * caller can persist and publish the user message before it answers HTTP 204.
 * Cancellation only removes queued work. A running turn has already reached
 * the model and must use the separate abort contract.
 */
export class TurnQueue<T> {
  private readonly entries = new Map<string, TurnEntry<T>>();
  private readonly pending: TurnEntry<T>[] = [];
  private draining = false;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly options: TurnQueueOptions<T>) {}

  enqueue(turn: T): {
    accepted: boolean;
    done: Promise<TurnCompletion>;
  } {
    const id = this.options.id(turn);
    const existing = this.entries.get(id);
    if (existing) return { accepted: false, done: existing.done };

    let resolve!: (outcome: TurnCompletion) => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<TurnCompletion>((doneResolve, doneReject) => {
      resolve = doneResolve;
      reject = doneReject;
    });
    const entry: TurnEntry<T> = { id, turn, state: 'queued', done, resolve, reject };

    this.options.onAccepted?.(turn);
    this.entries.set(id, entry);
    this.pending.push(entry);
    void this.drain();
    return { accepted: true, done };
  }

  state(id: string): TurnQueueState {
    return this.entries.get(id)?.state ?? 'missing';
  }

  cancel(id: string): TurnCancelOutcome {
    const entry = this.entries.get(id);
    if (!entry) return 'missing';
    if (entry.state === 'running') return 'running';

    const index = this.pending.indexOf(entry);
    if (index >= 0) this.pending.splice(index, 1);
    this.entries.delete(id);
    entry.resolve('cancelled');
    this.resolveIdleIfNeeded();
    return 'cancelled';
  }

  waitForIdle(): Promise<void> {
    if (!this.draining && this.pending.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const entry = this.pending.shift();
        if (!entry) break;
        if (!this.entries.has(entry.id)) continue;
        entry.state = 'running';
        try {
          const outcome = await this.options.run(entry.turn);
          entry.resolve(outcome ?? 'completed');
        } catch (error) {
          entry.reject(error);
        } finally {
          this.entries.delete(entry.id);
        }
      }
    } finally {
      this.draining = false;
      this.resolveIdleIfNeeded();
    }
  }

  private resolveIdleIfNeeded(): void {
    if (this.draining || this.pending.length > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
