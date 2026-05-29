import { describe, expect, test } from 'bun:test';

import {
  pickCanonicalRoot,
  resolvePinWrite,
  resolveRootSessionId,
  shouldCreateRoot,
} from './use-canonical-opencode-session';
import type { Session } from './use-opencode-sessions';

// Minimal Session factory — only the fields the resolver reads.
function sess(
  id: string,
  opts: { parentID?: string; created?: number } = {},
): Session {
  return {
    id,
    parentID: opts.parentID,
    time: { created: opts.created ?? 0, updated: opts.created ?? 0 },
  } as unknown as Session;
}

describe('pickCanonicalRoot', () => {
  test('returns null for an empty list', () => {
    expect(pickCanonicalRoot([])).toBeNull();
  });

  test('returns the only root', () => {
    expect(pickCanonicalRoot([sess('a', { created: 5 })])?.id).toBe('a');
  });

  test('picks the OLDEST root by creation time (not recency)', () => {
    const list = [
      sess('new', { created: 300 }),
      sess('old', { created: 100 }),
      sess('mid', { created: 200 }),
    ];
    expect(pickCanonicalRoot(list)?.id).toBe('old');
  });

  test('ignores sub-sessions (parentID set)', () => {
    const list = [
      sess('sub', { parentID: 'root', created: 1 }), // older but a sub-session
      sess('root', { created: 50 }),
    ];
    expect(pickCanonicalRoot(list)?.id).toBe('root');
  });

  test('breaks ties on identical timestamps by id (total, deterministic order)', () => {
    const list = [sess('b', { created: 100 }), sess('a', { created: 100 })];
    expect(pickCanonicalRoot(list)?.id).toBe('a');
    // Order-independent: same answer regardless of input ordering.
    expect(pickCanonicalRoot([...list].reverse())?.id).toBe('a');
  });

  test('returns null when only sub-sessions exist', () => {
    expect(pickCanonicalRoot([sess('s', { parentID: 'x' })])).toBeNull();
  });
});

describe('resolveRootSessionId', () => {
  test('honors the pin while it still exists — even if an older root exists', () => {
    const sessions = [sess('old', { created: 1 }), sess('pinned', { created: 9 })];
    expect(
      resolveRootSessionId({ pinnedRootId: 'pinned', sessions }),
    ).toBe('pinned');
  });

  test('heals a stale pin by adopting the canonical (oldest) root', () => {
    const sessions = [sess('newRoot', { created: 9 }), sess('oldRoot', { created: 1 })];
    // pin points at a session this sandbox no longer has (e.g. rebuilt DB).
    expect(
      resolveRootSessionId({ pinnedRootId: 'ghost', sessions }),
    ).toBe('oldRoot');
  });

  test('with no pin yet, adopts the canonical root (never creates a duplicate)', () => {
    const sessions = [sess('r1', { created: 5 }), sess('r2', { created: 2 })];
    expect(
      resolveRootSessionId({ pinnedRootId: null, sessions }),
    ).toBe('r2');
  });

  test('empty DB falls back to the just-created id', () => {
    expect(
      resolveRootSessionId({ pinnedRootId: null, sessions: [], justCreatedId: 'fresh' }),
    ).toBe('fresh');
  });

  test('empty DB with nothing created yet resolves to null (still resolving)', () => {
    expect(resolveRootSessionId({ pinnedRootId: null, sessions: [] })).toBeNull();
  });

  test('stale pin + only sub-sessions present falls back to just-created', () => {
    const sessions = [sess('sub', { parentID: 'gone' })];
    expect(
      resolveRootSessionId({ pinnedRootId: 'gone', sessions, justCreatedId: 'new' }),
    ).toBe('new');
  });

  test('two clients with the same DB state converge on the same id', () => {
    const a = [sess('x', { created: 100 }), sess('y', { created: 50 })];
    const b = [sess('y', { created: 50 }), sess('x', { created: 100 })]; // different order
    expect(resolveRootSessionId({ pinnedRootId: null, sessions: a })).toBe(
      resolveRootSessionId({ pinnedRootId: null, sessions: b }),
    );
  });
});

describe('shouldCreateRoot', () => {
  const base = {
    runtimeReady: true,
    serverId: 'srv-1',
    listSettled: true,
    pinPresent: false,
    sessions: [] as Session[],
    alreadyCreated: false,
  };

  test('creates exactly when the sandbox is ready, settled, and truly empty', () => {
    expect(shouldCreateRoot(base)).toBe(true);
  });

  test('never creates before the runtime is ready', () => {
    expect(shouldCreateRoot({ ...base, runtimeReady: false })).toBe(false);
  });

  test('never creates without a sandbox server id', () => {
    expect(shouldCreateRoot({ ...base, serverId: null })).toBe(false);
  });

  test('never creates off an unsettled (loading/errored) list', () => {
    expect(shouldCreateRoot({ ...base, listSettled: false })).toBe(false);
  });

  test('never creates when a valid pin is present', () => {
    expect(shouldCreateRoot({ ...base, pinPresent: true })).toBe(false);
  });

  test('never creates when a root already exists (adopt instead)', () => {
    expect(shouldCreateRoot({ ...base, sessions: [sess('r', { created: 1 })] })).toBe(false);
  });

  test('creates when only sub-sessions exist (no root)', () => {
    expect(shouldCreateRoot({ ...base, sessions: [sess('s', { parentID: 'x' })] })).toBe(true);
  });

  test('never creates twice for the same sandbox (one-shot guard)', () => {
    expect(shouldCreateRoot({ ...base, alreadyCreated: true })).toBe(false);
  });
});

describe('resolvePinWrite', () => {
  const base = {
    runtimeReady: true,
    rootSessionId: 'root' as string | null,
    pinnedRootId: null as string | null,
    sessions: [sess('root', { created: 1 })],
    attemptedTarget: null as string | null,
  };

  test('writes the resolved root when nothing is pinned yet', () => {
    expect(resolvePinWrite(base)).toBe('root');
  });

  test('does not write when the pin already matches (no thrash)', () => {
    expect(resolvePinWrite({ ...base, pinnedRootId: 'root' })).toBeNull();
  });

  test('heals a divergent pin to the resolved root', () => {
    expect(resolvePinWrite({ ...base, pinnedRootId: 'stale' })).toBe('root');
  });

  test('does not re-fire while a write for the same target is in flight', () => {
    expect(resolvePinWrite({ ...base, attemptedTarget: 'root' })).toBeNull();
  });

  test('never writes before the runtime is ready', () => {
    expect(resolvePinWrite({ ...base, runtimeReady: false })).toBeNull();
  });

  test('never writes a null root', () => {
    expect(resolvePinWrite({ ...base, rootSessionId: null })).toBeNull();
  });

  test('never pins a sub-session (has parentID) as the root', () => {
    const sessions = [sess('sub', { parentID: 'p' })];
    expect(resolvePinWrite({ ...base, rootSessionId: 'sub', sessions })).toBeNull();
  });

  test('writes a just-created root not yet present in the list', () => {
    // rootSessionId came from the create mutation; list cache not updated yet.
    expect(resolvePinWrite({ ...base, rootSessionId: 'fresh', sessions: [] })).toBe('fresh');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Lifecycle simulation
//
// Faithfully reproduces the hook's per-render logic (resolve → create-decision
// → pin-decision) and drives it through a mock sandbox DB + persisted pin
// across MANY re-renders and remounts. Proves the *interaction* converges:
// exactly one create, the pin heals, and nothing thrashes (which the original
// recency-fallback code did). This is the regression guard for "session
// replaced / data looked lost".
// ─────────────────────────────────────────────────────────────────────────

interface World {
  sessions: Session[]; // the sandbox's live OpenCode DB
  pin: string | null; // persisted project_sessions.opencode_session_id
  creates: number; // total session.create() calls issued
  pinWrites: number; // total PATCH opencode_session_id calls issued
}

interface Env {
  runtimeReady: boolean;
  serverId: string | null;
  listSettled: boolean;
}

// One render + the actions the driver applies, mirroring the hook exactly:
//  - create seeds the new root into the list synchronously (real onSuccess does
//    setQueryData), bumping `creates` and marking the sandbox guard.
//  - a pin write succeeds synchronously, updating the persisted pin.
function step(world: World, env: Env, guard: Set<string>, attempt: { v: string | null }) {
  const pinPresent = !!world.pin && world.sessions.some((s) => s.id === world.pin);
  const justCreatedId =
    world.sessions.find((s) => !s.parentID && s.id.startsWith('created-'))?.id ?? null;
  const rootSessionId = resolveRootSessionId({
    pinnedRootId: world.pin,
    sessions: world.sessions,
    justCreatedId,
  });

  if (
    env.serverId &&
    shouldCreateRoot({
      runtimeReady: env.runtimeReady,
      serverId: env.serverId,
      listSettled: env.listSettled,
      pinPresent,
      sessions: world.sessions,
      alreadyCreated: guard.has(env.serverId),
    })
  ) {
    guard.add(env.serverId);
    world.creates += 1;
    const id = `created-${world.creates}`;
    world.sessions = [...world.sessions, sess(id, { created: 1_000 + world.creates })];
  }

  // Pin/heal effect: short-circuit when already in sync (records attempt), else
  // write the resolved target.
  if (world.pin === rootSessionId) {
    attempt.v = rootSessionId;
  } else {
    const target = resolvePinWrite({
      runtimeReady: env.runtimeReady,
      rootSessionId,
      pinnedRootId: world.pin,
      sessions: world.sessions,
      attemptedTarget: attempt.v,
    });
    if (target) {
      attempt.v = target;
      world.pinWrites += 1;
      world.pin = target; // PATCH success
    }
  }

  return rootSessionId;
}

// Render repeatedly until two consecutive renders produce no state change, or
// fail loudly if it never settles (i.e. it thrashes).
function runToStable(world: World, env: Env, guard: Set<string>, attempt: { v: string | null }) {
  let last = '';
  let resolved: string | null = null;
  for (let i = 0; i < 50; i++) {
    resolved = step(world, env, guard, attempt);
    const sig = `${world.pin}|${world.sessions.map((s) => s.id).join(',')}|${world.creates}|${world.pinWrites}`;
    if (sig === last) return { resolved, settled: true };
    last = sig;
  }
  return { resolved, settled: false };
}

const READY: Env = { runtimeReady: true, serverId: 'srv-1', listSettled: true };

describe('lifecycle simulation', () => {
  test('fresh empty sandbox → exactly one create, pin set, stable', () => {
    const world: World = { sessions: [], pin: null, creates: 0, pinWrites: 0 };
    const guard = new Set<string>();
    const { resolved, settled } = runToStable(world, READY, guard, { v: null });
    expect(settled).toBe(true);
    expect(world.creates).toBe(1);
    expect(world.pin).toBe('created-1');
    expect(resolved).toBe('created-1');
    expect(world.pinWrites).toBe(1);
  });

  test('remount during the empty window NEVER mints a second root', () => {
    const world: World = { sessions: [], pin: null, creates: 0, pinWrites: 0 };
    const guard = new Set<string>(); // module-level guard survives remounts
    // First mount issues the create...
    step(world, READY, guard, { v: null });
    expect(world.creates).toBe(1);
    // ...now simulate a remount BEFORE the list reflects it (fresh attempt ref,
    // and pretend the list momentarily reads empty again). Reset the counter so
    // we measure ONLY what this remount issues.
    const remountWorld: World = { ...world, sessions: [], creates: 0 };
    runToStable(remountWorld, READY, guard, { v: null });
    // Same module-level guard → this remount issues NO new create even though
    // the list momentarily looked empty (the original duplicate-root bug).
    expect(remountWorld.creates).toBe(0);
    expect(guard.size).toBe(1); // still exactly one create across both mounts
  });

  test('existing valid pin → zero creates, zero writes, no flip', () => {
    const world: World = {
      sessions: [sess('root', { created: 10 }), sess('dup', { created: 99 })],
      pin: 'root',
      creates: 0,
      pinWrites: 0,
    };
    const { resolved, settled } = runToStable(world, READY, new Set(), { v: null });
    expect(settled).toBe(true);
    expect(resolved).toBe('root'); // pin honored despite a newer duplicate root
    expect(world.creates).toBe(0);
    expect(world.pinWrites).toBe(0);
  });

  test('duplicate roots + recency churn never flips the active session', () => {
    const world: World = {
      sessions: [sess('root', { created: 10 }), sess('dup', { created: 5 })],
      pin: 'root',
      creates: 0,
      pinWrites: 0,
    };
    const attempt = { v: null as string | null };
    const guard = new Set<string>();
    // Bump the duplicate's "updated" repeatedly (simulating activity). The old
    // code sorted by updated and would flip to `dup`; we must stay on `root`.
    for (let i = 0; i < 5; i++) {
      world.sessions = world.sessions.map((s) =>
        s.id === 'dup' ? ({ ...s, time: { ...s.time, updated: 100 + i } } as Session) : s,
      );
      const resolved = step(world, READY, guard, attempt);
      expect(resolved).toBe('root');
    }
    expect(world.creates).toBe(0);
    expect(world.pinWrites).toBe(0);
  });

  test('stale pin + a real root present → heals to it, no create', () => {
    const world: World = {
      sessions: [sess('realRoot', { created: 7 })],
      pin: 'ghost', // points at a session this sandbox no longer has
      creates: 0,
      pinWrites: 0,
    };
    const { resolved, settled } = runToStable(world, READY, new Set(), { v: null });
    expect(settled).toBe(true);
    expect(resolved).toBe('realRoot');
    expect(world.pin).toBe('realRoot'); // healed
    expect(world.creates).toBe(0); // adopted, not recreated
    expect(world.pinWrites).toBe(1);
  });

  test('stale pin + wiped DB (rebuilt sandbox) → one create, pin healed', () => {
    const world: World = { sessions: [], pin: 'ghost', creates: 0, pinWrites: 0 };
    const { resolved, settled } = runToStable(world, READY, new Set(), { v: null });
    expect(settled).toBe(true);
    expect(world.creates).toBe(1);
    expect(world.pin).toBe('created-1');
    expect(resolved).toBe('created-1');
  });

  test('user deletes the pinned root → recovers to another root and re-pins', () => {
    const world: World = {
      sessions: [sess('A', { created: 1 }), sess('B', { created: 2 })],
      pin: 'A',
      creates: 0,
      pinWrites: 0,
    };
    // Stable on A first.
    const guard = new Set<string>();
    const attempt = { v: null as string | null };
    runToStable(world, READY, guard, attempt);
    expect(world.pin).toBe('A');
    // Now A is deleted.
    world.sessions = world.sessions.filter((s) => s.id !== 'A');
    const { resolved, settled } = runToStable(world, READY, guard, attempt);
    expect(settled).toBe(true);
    expect(resolved).toBe('B');
    expect(world.pin).toBe('B'); // healed to the surviving root
    expect(world.creates).toBe(0); // B already existed
  });

  test('does not act until the runtime is ready and the list has settled', () => {
    const world: World = { sessions: [], pin: null, creates: 0, pinWrites: 0 };
    const guard = new Set<string>();
    // Not ready yet.
    step(world, { runtimeReady: false, serverId: 'srv-1', listSettled: false }, guard, { v: null });
    // Ready but list still loading.
    step(world, { runtimeReady: true, serverId: 'srv-1', listSettled: false }, guard, { v: null });
    expect(world.creates).toBe(0);
    expect(world.pinWrites).toBe(0);
    // Now settled → it acts.
    runToStable(world, READY, guard, { v: null });
    expect(world.creates).toBe(1);
  });
});
