import { describe, expect, it, test } from 'bun:test';
import type { OutputItem } from '../shared/derive-panels';
import type { Step } from '../shared/group-steps';
import {
  deriveIsRunning,
  neighborOutputs,
  outputKey,
  shouldAutoExpandOutputs,
  shouldAutoOpenPayoff,
  stepForCallId,
} from './easy-panel-logic';

type FileOutputItem = Exclude<OutputItem, { kind: 'app' }> & { kind: 'file' };

function output(overrides: Partial<FileOutputItem> = {}): FileOutputItem {
  return { callID: 'call-1', name: 'report.md', kind: 'file', ...overrides };
}

describe('outputKey', () => {
  it('is stable for a single item', () => {
    expect(outputKey(output())).toBe('call-1:report.md');
  });

  it('prefers path over name when both are present', () => {
    expect(outputKey(output({ path: '/a/report.md' }))).toBe('call-1:/a/report.md');
  });

  // ─── the bug the brief shipped: one apply_patch call produces several
  // OutputItems that all share the same callID. Keying on callID alone
  // collides; the key must still distinguish every file the call touched. ──

  it('does not collide for multiple files from the same apply_patch call', () => {
    const a = output({ callID: 'patch-1', path: '/repo/src/a.ts', name: 'a.ts' });
    const b = output({ callID: 'patch-1', path: '/repo/src/b.ts', name: 'b.ts' });
    expect(outputKey(a)).not.toBe(outputKey(b));
  });

  it('still distinguishes same-call items that have no path, only a name', () => {
    const a = output({ callID: 'patch-1', path: undefined, name: 'a.ts' });
    const b = output({ callID: 'patch-1', path: undefined, name: 'b.ts' });
    expect(outputKey(a)).not.toBe(outputKey(b));
  });

  it('keeps two different calls to the same path apart', () => {
    const a = output({ callID: 'call-a', path: '/a/report.md' });
    const b = output({ callID: 'call-b', path: '/a/report.md' });
    expect(outputKey(a)).not.toBe(outputKey(b));
  });
});

describe('shouldAutoExpandOutputs', () => {
  it('opens exactly on the running -> idle transition when there is content', () => {
    expect(shouldAutoExpandOutputs(true, false, 1)).toBe(true);
  });

  it('does not open while still running', () => {
    expect(shouldAutoExpandOutputs(true, true, 3)).toBe(false);
  });

  it('does not open on every render once already idle (no transition this tick)', () => {
    expect(shouldAutoExpandOutputs(false, false, 3)).toBe(false);
  });

  it('does not open when a run finishes with nothing to show', () => {
    expect(shouldAutoExpandOutputs(true, false, 0)).toBe(false);
  });

  it('does not open when a run is just starting (idle -> running)', () => {
    expect(shouldAutoExpandOutputs(false, true, 3)).toBe(false);
  });
});

describe('deriveIsRunning', () => {
  // ─── BUG 4 — between one tool call completing and the next being emitted,
  // the model streams assistant text and NO tool part is running/pending, so
  // a part-only signal flips true→false→true on every tool boundary of a
  // normal run: the Outputs card pops open at the first inter-tool gap
  // instead of at the actual finish, and the Progress card's shimmer/subtitle
  // flicker. The session's own status (the same signal the chat transcript
  // already uses for its working indicator) stays busy for the whole turn,
  // so ORing it in closes the gap without inventing a new source of truth. ──

  it('is true while a step is actively running, even if the session status lags behind', () => {
    expect(deriveIsRunning(true, false)).toBe(true);
  });

  it('is true during an inter-tool gap (no part running) as long as the session itself is busy', () => {
    expect(deriveIsRunning(false, true)).toBe(true);
  });

  it('is true when both signals agree the run is active', () => {
    expect(deriveIsRunning(true, true)).toBe(true);
  });

  it('is false only when neither signal says the run is active', () => {
    expect(deriveIsRunning(false, false)).toBe(false);
  });
});

describe('shouldAutoOpenPayoff (W2)', () => {
  const base = {
    wasRunning: true,
    isRunning: false,
    outcome: 'succeeded' as const,
    hasPrimary: true,
    detailOpen: false,
    interactedThisRun: false,
    panelOpen: true,
  };

  test('fires exactly at the successful running→idle transition with a primary', () => {
    expect(shouldAutoOpenPayoff(base)).toBe(true);
  });

  test('never without a transition, primary, or success', () => {
    expect(shouldAutoOpenPayoff({ ...base, wasRunning: false })).toBe(false);
    expect(shouldAutoOpenPayoff({ ...base, isRunning: true })).toBe(false);
    expect(shouldAutoOpenPayoff({ ...base, hasPrimary: false })).toBe(false);
    expect(shouldAutoOpenPayoff({ ...base, outcome: 'failed' })).toBe(false);
    expect(shouldAutoOpenPayoff({ ...base, outcome: 'stopped' })).toBe(false);
  });

  test('never steals from a user who is (or was) looking at a detail this run', () => {
    expect(shouldAutoOpenPayoff({ ...base, detailOpen: true })).toBe(false);
    expect(shouldAutoOpenPayoff({ ...base, interactedThisRun: true })).toBe(false);
  });

  // ─── IMPORTANT 6 — desktop keeps EasyPanel mounted behind a closed panel.
  // Without this refusal the payoff would silently open a detail the user
  // can't see; the closed-panel case belongs to the ready chip (W1) instead. ──
  test('never fires behind a closed panel, even when every other condition is met', () => {
    expect(shouldAutoOpenPayoff({ ...base, panelOpen: false })).toBe(false);
  });
});

describe('stepForCallId (chat -> panel focus)', () => {
  const steps = [
    { id: 's1', parts: [{ callID: 'c1' }, { callID: 'c2' }] },
    { id: 's2', parts: [{ callID: 'c3' }] },
  ] as unknown as Step[];

  it('finds the step owning a given call, and returns undefined for an unknown call', () => {
    expect(stepForCallId(steps, 'c2')?.id).toBe('s1');
    expect(stepForCallId(steps, 'zz')).toBeUndefined();
  });
});

describe('neighborOutputs (W10)', () => {
  const items = [
    { callID: 'a', name: 'report.pdf', kind: 'file' as const, path: 'report.pdf' },
    { callID: 'b', name: 'data.csv', kind: 'file' as const, path: 'data.csv' },
    { callID: 'c', name: 'img.png', kind: 'image' as const, path: 'img.png' },
  ];

  test('middle item has both neighbors and a position', () => {
    const { prev, next, position } = neighborOutputs(items, 'b:data.csv');
    expect(prev?.callID).toBe('a');
    expect(next?.callID).toBe('c');
    expect(position).toBe('2 of 3');
  });

  test('edges have null on their open side; unknown key has neither', () => {
    expect(neighborOutputs(items, 'a:report.pdf').prev).toBeNull();
    expect(neighborOutputs(items, 'c:img.png').next).toBeNull();
    expect(neighborOutputs(items, 'zz').prev).toBeNull();
    expect(neighborOutputs(items, 'zz').next).toBeNull();
  });
});
