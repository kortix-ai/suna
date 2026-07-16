import { beforeEach, describe, expect, test } from 'bun:test';
import { useKortixComputerStore } from './kortix-computer-store';

describe('ready chip state (W1)', () => {
  beforeEach(() => {
    useKortixComputerStore.getState().reset();
  });

  test('set → read → clear', () => {
    const s = useKortixComputerStore.getState();
    s.setReadyChip({ sessionId: 's1', outcome: 'ready', count: 3, primaryName: 'Quarterly report' });
    expect(useKortixComputerStore.getState().readyChip?.primaryName).toBe('Quarterly report');
    useKortixComputerStore.getState().clearReadyChip();
    expect(useKortixComputerStore.getState().readyChip).toBeNull();
  });

  test('opening the panel clears the chip — a seen panel needs no announcement', () => {
    const s = useKortixComputerStore.getState();
    s.setActiveSession('s1');
    s.setReadyChip({ sessionId: 's1', outcome: 'ready', count: 1 });
    s.setIsSidePanelOpen(true);
    expect(useKortixComputerStore.getState().readyChip).toBeNull();
  });

  test('primary-open request is one-shot and session-scoped', () => {
    const s = useKortixComputerStore.getState();
    s.requestPrimaryOpen('s1');
    expect(useKortixComputerStore.getState().consumePrimaryOpen('other')).toBe(false);
    expect(useKortixComputerStore.getState().consumePrimaryOpen('s1')).toBe(true);
    expect(useKortixComputerStore.getState().consumePrimaryOpen('s1')).toBe(false);
  });

  test('quick-view request is one-shot and session-scoped', () => {
    const s = useKortixComputerStore.getState();
    s.setActiveSession('s1');
    s.requestQuickView('terminal');
    expect(useKortixComputerStore.getState().consumeQuickView('other')).toBeNull();
    expect(useKortixComputerStore.getState().consumeQuickView('s1')).toBe('terminal');
    expect(useKortixComputerStore.getState().consumeQuickView('s1')).toBeNull();
  });

  test('quick-view request opens the panel and updates the per-session map', () => {
    const s = useKortixComputerStore.getState();
    s.setActiveSession('s1');
    s.requestQuickView('audit');
    expect(useKortixComputerStore.getState().isSidePanelOpen).toBe(true);
    s.setActiveSession(null);
    s.setActiveSession('s1');
    // Panel state was persisted for s1 while it was active — restoring it
    // should come back open.
    expect(useKortixComputerStore.getState().isSidePanelOpen).toBe(true);
  });

  test('quick-view request clears only the active session\'s own ready chip', () => {
    const s = useKortixComputerStore.getState();
    s.setReadyChip({ sessionId: 'other', outcome: 'ready', count: 1 });
    s.setActiveSession('s1');
    s.requestQuickView('terminal');
    expect(useKortixComputerStore.getState().readyChip?.sessionId).toBe('other');

    s.setReadyChip({ sessionId: 's1', outcome: 'ready', count: 1 });
    s.requestQuickView('terminal');
    expect(useKortixComputerStore.getState().readyChip).toBeNull();
  });

  test('quick-view request with no active session opens the panel but sets no pending view', () => {
    const s = useKortixComputerStore.getState();
    s.setActiveSession(null);
    s.requestQuickView('audit');
    expect(useKortixComputerStore.getState().isSidePanelOpen).toBe(true);
    expect(useKortixComputerStore.getState().pendingQuickView).toBeNull();
  });

  // ─── IMPORTANT 4 — cross-session chip bleed. Opening session B's panel must
  // never destroy session A's still-unseen ready chip; it may only clear a
  // chip that belongs to the session actually being opened. Covers all three
  // panel-opening actions: setIsSidePanelOpen(true), openSidePanel, focusToolCall. ──
  describe('chip clearing is session-scoped, not global', () => {
    test('setIsSidePanelOpen(true): another session\'s chip survives; this session\'s chip clears', () => {
      const s = useKortixComputerStore.getState();
      s.setReadyChip({ sessionId: 'other', outcome: 'ready', count: 1 });
      s.setActiveSession('s1');
      s.setIsSidePanelOpen(true);
      expect(useKortixComputerStore.getState().readyChip?.sessionId).toBe('other');

      s.setReadyChip({ sessionId: 's1', outcome: 'ready', count: 1 });
      s.setIsSidePanelOpen(true);
      expect(useKortixComputerStore.getState().readyChip).toBeNull();
    });

    test('openSidePanel: another session\'s chip survives; this session\'s chip clears', () => {
      const s = useKortixComputerStore.getState();
      s.setReadyChip({ sessionId: 'other', outcome: 'ready', count: 1 });
      s.setActiveSession('s1');
      s.openSidePanel();
      expect(useKortixComputerStore.getState().readyChip?.sessionId).toBe('other');

      s.setReadyChip({ sessionId: 's1', outcome: 'ready', count: 1 });
      s.openSidePanel();
      expect(useKortixComputerStore.getState().readyChip).toBeNull();
    });

    test('focusToolCall: another session\'s chip survives; this session\'s chip clears', () => {
      const s = useKortixComputerStore.getState();
      s.setReadyChip({ sessionId: 'other', outcome: 'ready', count: 1 });
      s.setActiveSession('s1');
      s.focusToolCall('call-1');
      expect(useKortixComputerStore.getState().readyChip?.sessionId).toBe('other');

      s.setReadyChip({ sessionId: 's1', outcome: 'ready', count: 1 });
      s.focusToolCall('call-2');
      expect(useKortixComputerStore.getState().readyChip).toBeNull();
    });
  });
});
