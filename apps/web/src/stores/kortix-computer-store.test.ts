import { beforeEach, describe, expect, it, test } from 'bun:test';
import { useKortixComputerStore, QUICK_VIEW_TTL_MS } from './kortix-computer-store';

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

  test('quick-view request round-trips the browser view', () => {
    const s = useKortixComputerStore.getState();
    s.setActiveSession('s1');
    s.requestQuickView('browser');
    expect(useKortixComputerStore.getState().consumeQuickView('other')).toBeNull();
    expect(useKortixComputerStore.getState().consumeQuickView('s1')).toBe('browser');
    expect(useKortixComputerStore.getState().consumeQuickView('s1')).toBeNull();
  });

  test('an explicit session id works when no active session is set — the standalone-route case', () => {
    // On /projects/:id/sessions/:id the session is not in the tab system, so
    // `_activeSessionId` stays null; without the explicit id the pending view
    // was silently dropped (panel opened, terminal never came).
    const s = useKortixComputerStore.getState();
    s.setActiveSession(null);
    s.requestQuickView('terminal', 's1');
    expect(useKortixComputerStore.getState().isSidePanelOpen).toBe(true);
    expect(useKortixComputerStore.getState().consumeQuickView('s1')).toBe('terminal');
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

describe('panelSplit (width override for presentation/terminal layers)', () => {
  beforeEach(() => {
    useKortixComputerStore.getState().reset();
  });

  test('defaults to null and can be set and cleared', () => {
    expect(useKortixComputerStore.getState().panelSplit).toBeNull();
    useKortixComputerStore.getState().setPanelSplit(70);
    expect(useKortixComputerStore.getState().panelSplit).toBe(70);
    useKortixComputerStore.getState().setPanelSplit(50);
    expect(useKortixComputerStore.getState().panelSplit).toBe(50);
    useKortixComputerStore.getState().setPanelSplit(null);
    expect(useKortixComputerStore.getState().panelSplit).toBeNull();
  });

  test('animate: false sets the same skipNextExpandAnimation flag setIsExpanded uses', () => {
    const s = useKortixComputerStore.getState();
    s.setPanelSplit(70);
    expect(useKortixComputerStore.getState().skipNextExpandAnimation).toBe(false);
    s.setPanelSplit(null, { animate: false });
    expect(useKortixComputerStore.getState().panelSplit).toBeNull();
    expect(useKortixComputerStore.getState().skipNextExpandAnimation).toBe(true);
  });

  test('omitting opts (or animate: true) glides — flag stays false', () => {
    const s = useKortixComputerStore.getState();
    s.setPanelSplit(null, { animate: false });
    expect(useKortixComputerStore.getState().skipNextExpandAnimation).toBe(true);
    s.setPanelSplit(50);
    expect(useKortixComputerStore.getState().skipNextExpandAnimation).toBe(false);
  });

  test('setActiveSession resets panelSplit, mirroring isExpanded', () => {
    const s = useKortixComputerStore.getState();
    s.setActiveSession('s1');
    s.setPanelSplit(70);
    expect(useKortixComputerStore.getState().panelSplit).toBe(70);
    s.setActiveSession('s2');
    expect(useKortixComputerStore.getState().panelSplit).toBeNull();
  });

  test('closeSidePanel resets panelSplit', () => {
    const s = useKortixComputerStore.getState();
    s.setActiveSession('s1');
    s.setPanelSplit(50);
    s.closeSidePanel();
    expect(useKortixComputerStore.getState().panelSplit).toBeNull();
  });

  // ─── the REAL close path: the chat header toggle / ⌘I / mobile drawer all
  // call setIsSidePanelOpen(false) directly, never closeSidePanel — a stale
  // panelSplit/isExpanded must not survive a real close into the next open. ──
  test('setIsSidePanelOpen(false) resets panelSplit and isExpanded, snapping (not gliding)', () => {
    const s = useKortixComputerStore.getState();
    s.setActiveSession('s1');
    s.setIsSidePanelOpen(true);
    s.setPanelSplit(70);
    s.setIsExpanded(true);
    s.setIsSidePanelOpen(false);
    const after = useKortixComputerStore.getState();
    expect(after.panelSplit).toBeNull();
    expect(after.isExpanded).toBe(false);
    expect(after.skipNextExpandAnimation).toBe(true);
  });

  test('setIsSidePanelOpen(true) leaves the width states alone', () => {
    const s = useKortixComputerStore.getState();
    s.setActiveSession('s1');
    s.setPanelSplit(50);
    s.setIsSidePanelOpen(true);
    expect(useKortixComputerStore.getState().panelSplit).toBe(50);
    expect(useKortixComputerStore.getState().skipNextExpandAnimation).toBe(false);
  });
});

describe('pendingQuickView staleness', () => {
  beforeEach(() => {
    useKortixComputerStore.getState().reset();
  });

  test('a fresh request is consumed and returns its view', () => {
    const s = useKortixComputerStore.getState();
    s.requestQuickView('terminal', 'session-a');
    const now = useKortixComputerStore.getState().pendingQuickView!.requestedAt;
    expect(useKortixComputerStore.getState().consumeQuickView('session-a', now + 1000)).toBe(
      'terminal',
    );
    expect(useKortixComputerStore.getState().pendingQuickView).toBeNull();
  });

  test('a stale request is discarded, not acted on', () => {
    const s = useKortixComputerStore.getState();
    s.requestQuickView('terminal', 'session-a');
    const at = useKortixComputerStore.getState().pendingQuickView!.requestedAt;
    expect(
      useKortixComputerStore.getState().consumeQuickView('session-a', at + QUICK_VIEW_TTL_MS + 1),
    ).toBeNull();
    // Discarded on the failed consume — it must not survive to fire later.
    expect(useKortixComputerStore.getState().pendingQuickView).toBeNull();
  });

  test('switching the active session clears a request for a different session', () => {
    const s = useKortixComputerStore.getState();
    s.requestQuickView('terminal', 'session-a');
    s.setActiveSession('session-b');
    expect(useKortixComputerStore.getState().pendingQuickView).toBeNull();
  });

  test('switching TO the requesting session keeps the request', () => {
    const s = useKortixComputerStore.getState();
    s.requestQuickView('terminal', 'session-a');
    s.setActiveSession('session-a');
    expect(useKortixComputerStore.getState().pendingQuickView?.sessionId).toBe('session-a');
  });

  test('re-activating the already-active session still clears another session request', () => {
    const s = useKortixComputerStore.getState();
    s.setActiveSession('session-b');
    s.requestQuickView('terminal', 'session-a');
    s.setActiveSession('session-b'); // no-op re-activation
    expect(useKortixComputerStore.getState().pendingQuickView).toBeNull();
  });
});

describe('files quick-view destination', () => {
  beforeEach(() => {
    useKortixComputerStore.getState().reset();
  });

  it('carries a files quick-view request through to its consumer', () => {
    const s = useKortixComputerStore.getState();
    s.requestQuickView('files', 's1');
    expect(useKortixComputerStore.getState().pendingQuickView?.view).toBe('files');
    expect(useKortixComputerStore.getState().consumeQuickView('s1')).toBe('files');
  });

  it('clears the files request after one consume', () => {
    const s = useKortixComputerStore.getState();
    s.requestQuickView('files', 's1');
    useKortixComputerStore.getState().consumeQuickView('s1');
    expect(useKortixComputerStore.getState().consumeQuickView('s1')).toBeNull();
  });
});
