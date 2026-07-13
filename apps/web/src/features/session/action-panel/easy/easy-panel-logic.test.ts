import { describe, expect, it } from 'bun:test';
import type { OutputItem } from '../shared/derive-panels';
import { outputKey, shouldAutoExpandOutputs } from './easy-panel-logic';

function output(overrides: Partial<OutputItem> = {}): OutputItem {
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
