import { describe, expect, it } from 'bun:test';
import {
  deriveExplorerMode,
  explorerViewForMode,
  initialExplorerNonce,
} from './session-files-explorer-logic';

describe('deriveExplorerMode', () => {
  it('non-ephemeral: derives Changes from the files view value', () => {
    expect(deriveExplorerMode(false, 'files', 'files')).toBe('changes');
  });

  it('non-ephemeral: derives All files from any other (or unset) view value', () => {
    expect(deriveExplorerMode(false, 'files', 'explorer')).toBe('files');
    expect(deriveExplorerMode(false, 'files', undefined)).toBe('files');
  });

  // ─── the finding: Easy must never let the shared view value leak into its
  // rendered mode, even indirectly — it should read purely off local state. ──

  it('ephemeral: ignores rawView entirely, uses local mode verbatim', () => {
    expect(deriveExplorerMode(true, 'changes', 'files')).toBe('changes');
    expect(deriveExplorerMode(true, 'files', 'files')).toBe('files');
    expect(deriveExplorerMode(true, 'changes', undefined)).toBe('changes');
  });
});

describe('explorerViewForMode', () => {
  it('maps Changes to the files view value', () => {
    expect(explorerViewForMode('changes')).toBe('files');
  });

  it('maps All files to the explorer view value', () => {
    expect(explorerViewForMode('files')).toBe('explorer');
  });
});

describe('initialExplorerNonce', () => {
  it('non-ephemeral: always starts at 0, regardless of a pending request', () => {
    expect(initialExplorerNonce(false, 5)).toBe(0);
    expect(initialExplorerNonce(false, undefined)).toBe(0);
  });

  // ─── the finding: a stale request left by a chat click, already consumed by
  // Easy's own file-preview effect, must not replay when the explorer mounts
  // later — seeding from its current nonce marks it as already-seen. ──

  it('ephemeral: seeds from the pending request nonce so it is not replayed', () => {
    expect(initialExplorerNonce(true, 3)).toBe(3);
  });

  it('ephemeral: seeds 0 when there is no pending request', () => {
    expect(initialExplorerNonce(true, undefined)).toBe(0);
  });
});
