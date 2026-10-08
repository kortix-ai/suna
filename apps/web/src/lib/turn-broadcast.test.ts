import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * The cross-tab bridge for finished turns (KRTX-1795). The session page's
 * live stream is the only thing that hears a turn finish, so it publishes
 * here and every other Kortix tab runs its notification path on receipt.
 * bun test has no BroadcastChannel — a fake hub delivers postMessage to every
 * OTHER live instance, matching the real cross-context semantics.
 */

type Listener = (event: { data: unknown }) => void;

const hub = { instances: [] as { listeners: Listener[] }[] };

class FakeBroadcastChannel {
  listeners: Listener[] = [];
  constructor(name: string) {
    if (name !== 'kortix-turn-complete') throw new Error(`unexpected channel ${name}`);
    hub.instances.push(this);
  }
  postMessage(data: unknown) {
    for (const instance of hub.instances) {
      if (instance === this) continue;
      for (const listener of instance.listeners) listener({ data });
    }
  }
  addEventListener(_type: 'message', listener: Listener) {
    this.listeners.push(listener);
  }
  removeEventListener(_type: 'message', listener: Listener) {
    hub.instances.forEach((instance) => {
      instance.listeners = instance.listeners.filter((l) => l !== listener);
    });
  }
}

const world = globalThis as { BroadcastChannel?: unknown };
world.BroadcastChannel = FakeBroadcastChannel;

const { broadcastTurnComplete, onTurnComplete, createTurnCompleteGate, resetTurnBroadcastForTests } =
  await import('./turn-broadcast');

function msg(overrides: Partial<{ sessionId: string; at: number }> = {}) {
  return { sessionId: 'sess1', projectId: 'proj1', at: 1_000, ...overrides };
}

beforeEach(() => {
  hub.instances = [];
  resetTurnBroadcastForTests();
});

afterEach(() => {
  hub.instances = [];
  resetTurnBroadcastForTests();
});

describe('broadcastTurnComplete / onTurnComplete', () => {
  test('the publishing tab never receives its own event', () => {
    const local: string[] = [];
    onTurnComplete((m) => local.push(m.sessionId));

    broadcastTurnComplete({ sessionId: 'sess1' });

    expect(local).toEqual([]);
  });

  test('another tab receives the completion', () => {
    const received: { sessionId: string; projectId?: string | null }[] = [];
    onTurnComplete((m) => received.push({ sessionId: m.sessionId, projectId: m.projectId }));
    // The module caches one channel per tab; dropping the cache makes the next
    // publish mint a fresh instance — standing in for the other tab.
    resetTurnBroadcastForTests();

    broadcastTurnComplete({ sessionId: 'sess1', projectId: 'proj1' });

    expect(received).toEqual([{ sessionId: 'sess1', projectId: 'proj1' }]);
  });

  test('unsubscribing stops delivery', () => {
    const received: string[] = [];
    const off = onTurnComplete((m) => received.push(m.sessionId));
    off();
    resetTurnBroadcastForTests();

    broadcastTurnComplete({ sessionId: 'sess1' });

    expect(received).toEqual([]);
  });
});

describe('createTurnCompleteGate — what a receiving tab does with a relayed turn', () => {
  test('notifies a tab that is not watching the session', () => {
    const notified: string[] = [];
    const gate = createTurnCompleteGate(() => false, (m) => notified.push(m.sessionId));

    gate(msg());

    expect(notified).toEqual(['sess1']);
  });

  test('stays silent for the session this tab is viewing', () => {
    const notified: string[] = [];
    const gate = createTurnCompleteGate((id) => id === 'sess1', (m) => notified.push(m.sessionId));

    gate(msg());

    expect(notified).toEqual([]);
  });

  test('folds duplicate publications of the same turn', () => {
    const notified: string[] = [];
    const gate = createTurnCompleteGate(() => false, (m) => notified.push(m.sessionId));

    gate(msg({ at: 1_000 }));
    gate(msg({ at: 2_000 }));
    gate(msg({ sessionId: 'sess2', at: 3_000 }));

    // Two session pages of the same sandbox publish; one copy survives.
    expect(notified).toEqual(['sess1', 'sess2']);
  });

  test('a later completion of the same session after the fold window notifies again', () => {
    const notified: string[] = [];
    const gate = createTurnCompleteGate(() => false, (m) => notified.push(m.sessionId), 10_000);

    gate(msg({ at: 1_000 }));
    gate(msg({ at: 20_000 }));

    expect(notified).toEqual(['sess1', 'sess1']);
  });

  test('the default fold window only absorbs publish jitter, not real turns', () => {
    // Regression for the review of KRTX-1795: the window must stay short so a
    // second genuine completion minutes (or seconds) later still announces.
    const notified: string[] = [];
    const gate = createTurnCompleteGate(() => false, (m) => notified.push(m.sessionId));

    gate(msg({ at: 1_000 }));
    gate(msg({ at: 5_000 })); // well past cross-tab publish jitter

    expect(notified).toEqual(['sess1', 'sess1']);
  });
});
