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

describe('panelWide (wide split for presentation details)', () => {
  beforeEach(() => {
    useKortixComputerStore.getState().reset();
  });

  test('defaults to false and can be set and cleared', () => {
    expect(useKortixComputerStore.getState().panelWide).toBe(false);
    useKortixComputerStore.getState().setPanelWide(true);
    expect(useKortixComputerStore.getState().panelWide).toBe(true);
    useKortixComputerStore.getState().setPanelWide(false);
    expect(useKortixComputerStore.getState().panelWide).toBe(false);
  });

  test('animate: false sets the same skipNextExpandAnimation flag setIsExpanded uses', () => {
    const s = useKortixComputerStore.getState();
    s.setPanelWide(true);
    expect(useKortixComputerStore.getState().skipNextExpandAnimation).toBe(false);
    s.setPanelWide(false, { animate: false });
    expect(useKortixComputerStore.getState().panelWide).toBe(false);
    expect(useKortixComputerStore.getState().skipNextExpandAnimation).toBe(true);
  });

  test('omitting opts (or animate: true) glides — flag stays false', () => {
    const s = useKortixComputerStore.getState();
    s.setPanelWide(false, { animate: false });
    expect(useKortixComputerStore.getState().skipNextExpandAnimation).toBe(true);
    s.setPanelWide(true);
    expect(useKortixComputerStore.getState().skipNextExpandAnimation).toBe(false);
  });

  test('setActiveSession resets panelWide, mirroring isExpanded', () => {
    const s = useKortixComputerStore.getState();
    s.setActiveSession('s1');
    s.setPanelWide(true);
    expect(useKortixComputerStore.getState().panelWide).toBe(true);
    s.setActiveSession('s2');
    expect(useKortixComputerStore.getState().panelWide).toBe(false);
  });

  test('closeSidePanel resets panelWide', () => {
    const s = useKortixComputerStore.getState();
    s.setActiveSession('s1');
    s.setPanelWide(true);
    s.closeSidePanel();
    expect(useKortixComputerStore.getState().panelWide).toBe(false);
  });

  // ─── the REAL close path: the chat header toggle / ⌘I / mobile drawer all
  // call setIsSidePanelOpen(false) directly, never closeSidePanel — a stale
  // panelWide/isExpanded must not survive a real close into the next open. ──
  test('setIsSidePanelOpen(false) resets panelWide and isExpanded, snapping (not gliding)', () => {
    const s = useKortixComputerStore.getState();
    s.setActiveSession('s1');
    s.setIsSidePanelOpen(true);
    s.setPanelWide(true);
    s.setIsExpanded(true);
    s.setIsSidePanelOpen(false);
    const after = useKortixComputerStore.getState();
    expect(after.panelWide).toBe(false);
    expect(after.isExpanded).toBe(false);
    expect(after.skipNextExpandAnimation).toBe(true);
  });

  test('setIsSidePanelOpen(true) leaves the width states alone', () => {
    const s = useKortixComputerStore.getState();
    s.setActiveSession('s1');
    s.setPanelWide(true);
    s.setIsSidePanelOpen(true);
    expect(useKortixComputerStore.getState().panelWide).toBe(true);
    expect(useKortixComputerStore.getState().skipNextExpandAnimation).toBe(false);
  });
});
