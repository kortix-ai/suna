// SESSIONS ON ONE CELL SANDBOX MUST NOT SHARE A TRANSCRIPT.
//
// The control plane discovers a runtime's root by listing `GET /session`. That
// request carries no session anywhere, so on a shared cell host it reached the
// worker's default cell and every session pinned the same root. Measured on dev
// 2026-09-08: three sessions, one prompt each, all showing the same ten
// user/assistant pairs, all with opencode_session_id b673ad47-4365-4ab4-951d-0b592f9b9423.
import { describe, expect, test } from 'bun:test';
import { rootPinWithoutDiscovery } from './opencode-root-pin';

describe('pinning a runtime root', () => {
  test('a cell pins its own session id, without asking the box', () => {
    expect(rootPinWithoutDiscovery('cell', 'sess-1')).toBe('sess-1');
    expect(rootPinWithoutDiscovery('CELL', 'sess-1')).toBe('sess-1');
  });

  test('two sessions on ONE cell sandbox pin different roots — the leak', () => {
    // The whole point: the answer depends on the session, never on the box.
    expect(rootPinWithoutDiscovery('cell', 'a')).not.toBe(rootPinWithoutDiscovery('cell', 'b'));
  });

  test('anything else still discovers — OpenCode owns its own session ids', () => {
    expect(rootPinWithoutDiscovery('microvm', 'sess-1')).toBeNull();
    expect(rootPinWithoutDiscovery(null, 'sess-1')).toBeNull();
    expect(rootPinWithoutDiscovery(undefined, 'sess-1')).toBeNull();
    expect(rootPinWithoutDiscovery('', 'sess-1')).toBeNull();
  });

  test('a cell with no session id discovers rather than pinning nothing', () => {
    expect(rootPinWithoutDiscovery('cell', '')).toBeNull();
    expect(rootPinWithoutDiscovery('cell', '   ')).toBeNull();
  });
});
