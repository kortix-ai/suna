import { beforeEach, describe, expect, it, test } from 'bun:test';
import { QUICK_VIEW_TTL_MS, useKortixComputerStore } from './kortix-computer-store';

describe('ready chip state (W1)', () => {
  beforeEach(() => {
    useKortixComputerStore.getState().reset();
  });

  test('set → read → clear', () => {
    const s = useKortixComputerStore.getState();
    s.setReadyChip({
      sessionId: 's1',
      outcome: 'ready',
      count: 3,
      primaryName: 'Quarterly report',
    });
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
    expect(useKortixComputerStore.getState().consumeQuickView('s1')?.view).toBe('terminal');
    expect(useKortixComputerStore.getState().consumeQuickView('s1')).toBeNull();
  });

  test('quick-view request round-trips the browser view', () => {
    const s = useKortixComputerStore.getState();
    s.setActiveSession('s1');
    s.requestQuickView('browser');
    expect(useKortixComputerStore.getState().consumeQuickView('other')).toBeNull();
    expect(useKortixComputerStore.getState().consumeQuickView('s1')?.view).toBe('browser');
    expect(useKortixComputerStore.getState().consumeQuickView('s1')).toBeNull();
  });

  test('an explicit session id works when no active session is set', () => {
    // Callers that resolve the panel session themselves pass it explicitly;
    // without it the pending view used to be silently dropped (panel opened,
    // terminal never came).
    const s = useKortixComputerStore.getState();
    s.setActiveSession(null);
    s.requestQuickView('terminal', 's1');
    expect(useKortixComputerStore.getState().isSidePanelOpen).toBe(true);
    expect(useKortixComputerStore.getState().consumeQuickView('s1')?.view).toBe('terminal');
  });

  test('quick-view opens the panel, and leaving the session closes it again', () => {
    const s = useKortixComputerStore.getState();
    s.setActiveSession('s1');
    s.requestQuickView('audit');
    expect(useKortixComputerStore.getState().isSidePanelOpen).toBe(true);
    s.setActiveSession('s2');
    expect(useKortixComputerStore.getState().isSidePanelOpen).toBe(false);
    // And coming back does NOT reopen it — panel state does not travel with a
    // session. See `setActiveSession`.
    s.setActiveSession('s1');
    expect(useKortixComputerStore.getState().isSidePanelOpen).toBe(false);
  });

  test("quick-view request clears only the active session's own ready chip", () => {
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
    test("setIsSidePanelOpen(true): another session's chip survives; this session's chip clears", () => {
      const s = useKortixComputerStore.getState();
      s.setReadyChip({ sessionId: 'other', outcome: 'ready', count: 1 });
      s.setActiveSession('s1');
      s.setIsSidePanelOpen(true);
      expect(useKortixComputerStore.getState().readyChip?.sessionId).toBe('other');

      s.setReadyChip({ sessionId: 's1', outcome: 'ready', count: 1 });
      s.setIsSidePanelOpen(true);
      expect(useKortixComputerStore.getState().readyChip).toBeNull();
    });

    test("openSidePanel: another session's chip survives; this session's chip clears", () => {
      const s = useKortixComputerStore.getState();
      s.setReadyChip({ sessionId: 'other', outcome: 'ready', count: 1 });
      s.setActiveSession('s1');
      s.openSidePanel();
      expect(useKortixComputerStore.getState().readyChip?.sessionId).toBe('other');

      s.setReadyChip({ sessionId: 's1', outcome: 'ready', count: 1 });
      s.openSidePanel();
      expect(useKortixComputerStore.getState().readyChip).toBeNull();
    });

    test("focusToolCall: another session's chip survives; this session's chip clears", () => {
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

  // ─── the REAL close path: the detail's own close button / Escape / mobile
  // drawer all call setIsSidePanelOpen(false) directly, never closeSidePanel — a stale
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

describe('panelAspect (aspect-ratio-fit input, mirrors panelSplit)', () => {
  beforeEach(() => {
    useKortixComputerStore.getState().reset();
  });

  test('defaults to null and can be set and cleared', () => {
    expect(useKortixComputerStore.getState().panelAspect).toBeNull();
    useKortixComputerStore.getState().setPanelAspect(1.41);
    expect(useKortixComputerStore.getState().panelAspect).toBe(1.41);
    useKortixComputerStore.getState().setPanelAspect(null);
    expect(useKortixComputerStore.getState().panelAspect).toBeNull();
  });

  test('animate: false sets the same shared skipNextExpandAnimation flag setPanelSplit uses', () => {
    const s = useKortixComputerStore.getState();
    s.setPanelAspect(0.7);
    expect(useKortixComputerStore.getState().skipNextExpandAnimation).toBe(false);
    s.setPanelAspect(null, { animate: false });
    expect(useKortixComputerStore.getState().panelAspect).toBeNull();
    expect(useKortixComputerStore.getState().skipNextExpandAnimation).toBe(true);
  });

  // ─── the three sites that already clear panelSplit must clear panelAspect
  // alongside it, or the two states could disagree — a stale aspect from a
  // previous document surviving into a session/detail that never measured one. ──
  test('setIsSidePanelOpen(false) resets panelAspect', () => {
    const s = useKortixComputerStore.getState();
    s.setActiveSession('s1');
    s.setIsSidePanelOpen(true);
    s.setPanelAspect(1.41);
    s.setIsSidePanelOpen(false);
    expect(useKortixComputerStore.getState().panelAspect).toBeNull();
  });

  test('setActiveSession resets panelAspect, mirroring panelSplit', () => {
    const s = useKortixComputerStore.getState();
    s.setActiveSession('s1');
    s.setPanelAspect(1.41);
    expect(useKortixComputerStore.getState().panelAspect).toBe(1.41);
    s.setActiveSession('other');
    expect(useKortixComputerStore.getState().panelAspect).toBeNull();
  });

  test('closeSidePanel resets panelAspect', () => {
    const s = useKortixComputerStore.getState();
    s.setActiveSession('s1');
    s.setPanelAspect(0.7);
    s.closeSidePanel();
    expect(useKortixComputerStore.getState().panelAspect).toBeNull();
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
    expect(useKortixComputerStore.getState().consumeQuickView('session-a', now + 1000)?.view).toBe(
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
    expect(useKortixComputerStore.getState().consumeQuickView('s1')?.view).toBe('files');
  });

  it('clears the files request after one consume', () => {
    const s = useKortixComputerStore.getState();
    s.requestQuickView('files', 's1');
    useKortixComputerStore.getState().consumeQuickView('s1');
    expect(useKortixComputerStore.getState().consumeQuickView('s1')).toBeNull();
  });

  // ─── A quick-view that names WHERE it wants to land. Before this existed,
  // every caller that knew its destination (the show-tool preview button, a
  // localhost link in chat, the header chips) wrote `viewBySession` instead —
  // a key only Advanced mode reads, so in Easy the panel opened on the home
  // card and the destination was silently dropped. ──────────────────────────

  it('carries a browser target through to the consumer', () => {
    useKortixComputerStore
      .getState()
      .requestQuickView('browser', 's1', { url: 'https://proxy.test/p/3000', title: 'My app' });

    const request = useKortixComputerStore.getState().consumeQuickView('s1');

    expect(request?.view).toBe('browser');
    expect(request?.target?.url).toBe('https://proxy.test/p/3000');
    expect(request?.target?.title).toBe('My app');
  });

  it('carries the files Changes target, so a chip can land on the diff', () => {
    useKortixComputerStore.getState().requestQuickView('files', 's1', { changes: true });

    const request = useKortixComputerStore.getState().consumeQuickView('s1');

    expect(request?.view).toBe('files');
    expect(request?.target?.changes).toBe(true);
  });

  it('leaves target undefined for an untargeted request', () => {
    useKortixComputerStore.getState().requestQuickView('terminal', 's1');

    expect(useKortixComputerStore.getState().consumeQuickView('s1')?.target).toBeUndefined();
  });

  it('drops a stale targeted request rather than replaying it later', () => {
    useKortixComputerStore.getState().requestQuickView('browser', 's1', { url: 'https://a.test' });
    const at = useKortixComputerStore.getState().pendingQuickView!.requestedAt;

    expect(
      useKortixComputerStore.getState().consumeQuickView('s1', at + QUICK_VIEW_TTL_MS + 1),
    ).toBeNull();
  });
});

describe('mobile tool drawer state', () => {
  beforeEach(() => {
    useKortixComputerStore.getState().reset();
  });

  test('open → read → close', () => {
    useKortixComputerStore.getState().openMobileTool('terminal');
    expect(useKortixComputerStore.getState().mobileToolView).toBe('terminal');
    useKortixComputerStore.getState().closeMobileTool();
    expect(useKortixComputerStore.getState().mobileToolView).toBeNull();
  });

  test('opening a tool never opens the panel — the drawer is a peer, not a passenger', () => {
    useKortixComputerStore.getState().openMobileTool('browser');
    expect(useKortixComputerStore.getState().isSidePanelOpen).toBe(false);
    expect(useKortixComputerStore.getState().pendingQuickView).toBeNull();
  });

  test('reset clears an open tool', () => {
    useKortixComputerStore.getState().openMobileTool('files');
    useKortixComputerStore.getState().reset();
    expect(useKortixComputerStore.getState().mobileToolView).toBeNull();
  });
});

describe('floating action panel vs detail side panel — two flags, zero coupling', () => {
  beforeEach(() => {
    useKortixComputerStore.getState().reset();
  });

  test('opening the floating panel never opens the side panel', () => {
    const s = useKortixComputerStore.getState();
    s.setActiveSession('s1');
    s.setIsActionPanelOpen(true);
    expect(useKortixComputerStore.getState().isActionPanelOpen).toBe(true);
    expect(useKortixComputerStore.getState().isSidePanelOpen).toBe(false);
  });

  test('opening the side panel never opens the floating panel', () => {
    const s = useKortixComputerStore.getState();
    s.setActiveSession('s1');
    s.setIsSidePanelOpen(true);
    expect(useKortixComputerStore.getState().isSidePanelOpen).toBe(true);
    expect(useKortixComputerStore.getState().isActionPanelOpen).toBe(false);
  });

  test('every side-panel opener leaves the floating panel alone', () => {
    const s = useKortixComputerStore.getState();
    s.setActiveSession('s1');
    s.focusToolCall('call_1');
    s.openSidePanel();
    s.requestQuickView('terminal');
    expect(useKortixComputerStore.getState().isSidePanelOpen).toBe(true);
    expect(useKortixComputerStore.getState().isActionPanelOpen).toBe(false);
  });

  test('closing the floating panel leaves an open detail at its width', () => {
    const s = useKortixComputerStore.getState();
    s.setActiveSession('s1');
    s.setIsSidePanelOpen(true);
    s.setPanelSplit(70);
    s.setDetailOpen(true);
    s.setIsActionPanelOpen(true);
    s.setIsActionPanelOpen(false);
    const next = useKortixComputerStore.getState();
    expect(next.isSidePanelOpen).toBe(true);
    expect(next.panelSplit).toBe(70);
    expect(next.detailOpen).toBe(true);
  });

  test('toggle flips only the floating panel', () => {
    const s = useKortixComputerStore.getState();
    s.setActiveSession('s1');
    s.toggleActionPanel();
    expect(useKortixComputerStore.getState().isActionPanelOpen).toBe(true);
    useKortixComputerStore.getState().toggleActionPanel();
    expect(useKortixComputerStore.getState().isActionPanelOpen).toBe(false);
    expect(useKortixComputerStore.getState().isSidePanelOpen).toBe(false);
  });

  test('the two flags stay independent within one session', () => {
    const s = useKortixComputerStore.getState();
    s.setActiveSession('s1');
    s.setIsActionPanelOpen(true);
    s.setIsSidePanelOpen(true);
    expect(useKortixComputerStore.getState().isActionPanelOpen).toBe(true);
    s.setIsSidePanelOpen(false);
    expect(useKortixComputerStore.getState().isActionPanelOpen).toBe(true);
    expect(useKortixComputerStore.getState().isSidePanelOpen).toBe(false);
  });

  test('opening the floating panel clears that session ready chip', () => {
    const s = useKortixComputerStore.getState();
    s.setActiveSession('s1');
    s.setReadyChip({ sessionId: 's1', outcome: 'ready', count: 2 });
    s.setIsActionPanelOpen(true);
    expect(useKortixComputerStore.getState().readyChip).toBeNull();
  });

  test('opening the floating panel spares another session unseen chip', () => {
    const s = useKortixComputerStore.getState();
    s.setActiveSession('s1');
    s.setReadyChip({ sessionId: 's2', outcome: 'ready', count: 1 });
    s.setIsActionPanelOpen(true);
    expect(useKortixComputerStore.getState().readyChip?.sessionId).toBe('s2');
  });
});

/**
 * ⌘I / Ctrl+I — `toggleRightPanel`.
 *
 * The two surfaces stay independent in STATE (the suite above pins that), but
 * the user sees one region: whatever is docked right of the chat. One key
 * closes it, whatever it is, and brings back whatever it was.
 *
 * Before this, ⌘I was wired to the action panel alone, so a browser, terminal,
 * files view or file preview could not be closed from the keyboard at all —
 * and pressing the key under one of them silently moved a column hidden behind
 * it.
 */
describe('toggleRightPanel — one key for the whole right side', () => {
  beforeEach(() => {
    useKortixComputerStore.getState().reset();
    useKortixComputerStore.getState().setActiveSession('s1');
  });

  const state = () => useKortixComputerStore.getState();

  test('nothing open, nothing held → opens the action panel', () => {
    state().toggleRightPanel();
    expect(state().isActionPanelOpen).toBe(true);
    expect(state().isSidePanelOpen).toBe(false);
  });

  test('action panel open → closes it', () => {
    state().setIsActionPanelOpen(true);
    state().toggleRightPanel();
    expect(state().isActionPanelOpen).toBe(false);
    expect(state().isSidePanelOpen).toBe(false);
  });

  test('detail panel open → closes it (the browser/terminal/files case)', () => {
    state().setIsSidePanelOpen(true);
    state().toggleRightPanel();
    expect(state().isSidePanelOpen).toBe(false);
  });

  // The reported bug: with the cards open BEHIND a detail, closing only the
  // detail put the cards back on screen and the press read as "it didn't
  // close". Both go down together.
  test('both open → closes both, not just the one on top', () => {
    state().setIsActionPanelOpen(true);
    state().setIsSidePanelOpen(true);
    state().toggleRightPanel();
    expect(state().isSidePanelOpen).toBe(false);
    expect(state().isActionPanelOpen).toBe(false);
  });

  test('closing resets the width states and snaps rather than glides', () => {
    state().setIsSidePanelOpen(true);
    state().setPanelSplit(70);
    state().setPanelAspect(1.41);
    state().setIsExpanded(true);
    state().toggleRightPanel();
    const after = state();
    expect(after.panelSplit).toBeNull();
    expect(after.panelAspect).toBeNull();
    expect(after.isExpanded).toBe(false);
    expect(after.skipNextExpandAnimation).toBe(true);
  });

  // ─── WITHIN a session, ⌘I is minimise/restore: "open & close generally
  // whatever was last open". The detail's own content is the memory — the
  // close does not discard it. ──────────────────────────────────────────────

  test('a closed detail comes back on the next press', () => {
    state().setDetailContent('s1', true);
    state().setIsSidePanelOpen(true);
    state().toggleRightPanel();
    expect(state().isSidePanelOpen).toBe(false);
    state().toggleRightPanel();
    expect(state().isSidePanelOpen).toBe(true);
    expect(state().isActionPanelOpen).toBe(false);
  });

  test('closing is a minimise, not a discard — the content is kept', () => {
    state().setDetailContent('s1', true);
    state().setIsSidePanelOpen(true);
    state().toggleRightPanel();
    expect(state()._detailContentBySession.s1).toBe(true);
  });

  test('with cards behind a detail, the restore brings back the detail, not the cards', () => {
    state().setDetailContent('s1', true);
    state().setIsActionPanelOpen(true);
    state().setIsSidePanelOpen(true);
    state().toggleRightPanel();
    state().toggleRightPanel();
    expect(state().isSidePanelOpen).toBe(true);
    expect(state().isActionPanelOpen).toBe(false);
  });

  // The detail's own X / Escape DISCARD it — the provider drops its state and
  // publishes false. ⌘I then has nothing to restore.
  test('a detail dismissed by its own close button is not resurrected', () => {
    state().setDetailContent('s1', true);
    state().setIsSidePanelOpen(true);
    state().setIsSidePanelOpen(false);
    state().setDetailContent('s1', false);
    state().toggleRightPanel();
    expect(state().isSidePanelOpen).toBe(false);
    expect(state().isActionPanelOpen).toBe(true);
  });

  test("another session's detail is never what comes back", () => {
    state().setDetailContent('s2', true);
    state().toggleRightPanel();
    expect(state().isSidePanelOpen).toBe(false);
    expect(state().isActionPanelOpen).toBe(true);
  });

  test('an unmounted provider forgets its content, so ⌘I cannot reopen an empty panel', () => {
    state().setDetailContent('s1', true);
    state().setDetailContent('s1', null);
    expect(state()._detailContentBySession.s1).toBeUndefined();
    state().toggleRightPanel();
    expect(state().isActionPanelOpen).toBe(true);
  });

  test('with no active session it still opens the action panel', () => {
    state().setActiveSession(null);
    state().toggleRightPanel();
    expect(state().isActionPanelOpen).toBe(true);
  });
});

/**
 * The second reported bug: opening another session while a panel was up left
 * that panel on screen, showing the new session's empty/loading body — panel
 * state outlived the session it belonged to.
 *
 * The rule now is absolute: a session change closes both surfaces. There is no
 * per-session panel memory left to get this wrong.
 */
describe('a session change closes the right side', () => {
  beforeEach(() => {
    useKortixComputerStore.getState().reset();
  });

  const state = () => useKortixComputerStore.getState();

  test('an open detail panel does not follow you to the next session', () => {
    state().setActiveSession('s1');
    state().setIsSidePanelOpen(true);
    state().setActiveSession('s2');
    expect(state().isSidePanelOpen).toBe(false);
  });

  test('an open action panel does not follow you either', () => {
    state().setActiveSession('s1');
    state().setIsActionPanelOpen(true);
    state().setActiveSession('s2');
    expect(state().isActionPanelOpen).toBe(false);
  });

  test('both go down at once', () => {
    state().setActiveSession('s1');
    state().setIsActionPanelOpen(true);
    state().setIsSidePanelOpen(true);
    state().setActiveSession('s2');
    expect(state().isSidePanelOpen).toBe(false);
    expect(state().isActionPanelOpen).toBe(false);
  });

  test('returning to a session you left open still lands closed', () => {
    state().setActiveSession('s1');
    state().setIsSidePanelOpen(true);
    state().setActiveSession('s2');
    state().setActiveSession('s1');
    expect(state().isSidePanelOpen).toBe(false);
    expect(state().isActionPanelOpen).toBe(false);
  });

  test('leaving to no session at all also closes it', () => {
    state().setActiveSession('s1');
    state().setIsSidePanelOpen(true);
    state().setActiveSession(null);
    expect(state().isSidePanelOpen).toBe(false);
  });

  test('the width and detail states reset with it, snapping not gliding', () => {
    state().setActiveSession('s1');
    state().setIsSidePanelOpen(true);
    state().setPanelSplit(70);
    state().setPanelAspect(1.41);
    state().setIsExpanded(true);
    state().setDetailOpen(true);
    state().setActiveSession('s2');
    const after = state();
    expect(after.panelSplit).toBeNull();
    expect(after.panelAspect).toBeNull();
    expect(after.isExpanded).toBe(false);
    expect(after.detailOpen).toBe(false);
    expect(after.skipNextExpandAnimation).toBe(true);
  });

  // Re-activating the SAME session is a no-op (the layout's effect can re-run
  // on unrelated renders) — it must not slam a panel the user just opened.
  test('re-activating the same session leaves an open panel alone', () => {
    state().setActiveSession('s1');
    state().setIsSidePanelOpen(true);
    state().setActiveSession('s1');
    expect(state().isSidePanelOpen).toBe(true);
  });

  // Every other cross-session leak of the same shape: a global one-shot made
  // in session A, consumed by session B's layout/provider after the user
  // navigated. Each opened B's panel on something that was never B's.
  test('a pending open-the-panel request does not survive the switch', () => {
    state().setActiveSession('s1');
    state().openFileBrowser();
    expect(state().shouldOpenPanel).toBe(true);
    state().setActiveSession('s2');
    expect(state().shouldOpenPanel).toBe(false);
  });

  test('a pending tool-nav request does not survive the switch', () => {
    state().setActiveSession('s1');
    state().navigateToToolCall(3);
    expect(state().pendingToolNavIndex).toBe(3);
    state().setActiveSession('s2');
    expect(state().pendingToolNavIndex).toBeNull();
  });

  test('a focused tool call does not survive the switch', () => {
    state().setActiveSession('s1');
    state().focusToolCall('call-1');
    state().setActiveSession('s2');
    expect(state().focusedToolCallId).toBeNull();
  });

  test('the mobile tool drawer does not survive the switch', () => {
    state().setActiveSession('s1');
    state().openMobileTool('terminal');
    state().setActiveSession('s2');
    expect(state().mobileToolView).toBeNull();
  });

  // The one announcement that IS allowed to cross sessions — telling you
  // session A finished while you are looking at B is the whole point.
  test("another session's ready chip is spared", () => {
    state().setActiveSession('s1');
    state().setReadyChip({ sessionId: 's1', outcome: 'ready', count: 1 });
    state().setActiveSession('s2');
    expect(state().readyChip?.sessionId).toBe('s1');
  });

  // ─── The ⌘I restore memory is session-scoped. Within a session the key is a
  // minimise/restore pair; across a session change it is not. This is the
  // difference between "close the browser, press again, browser is back" and
  // "close the browser, go to another page, come back, press — cards". ──────

  test('leaving the session wipes what ⌘I would restore', () => {
    state().setActiveSession('s1');
    state().setDetailContent('s1', true);
    state().setActiveSession('s2');
    expect(state()._detailContentBySession).toEqual({});
  });

  test('a session you return to opens the cards, not the detail you left up', () => {
    state().setActiveSession('s1');
    state().setDetailContent('s1', true);
    state().setIsSidePanelOpen(true);
    state().setActiveSession('s2');
    state().setActiveSession('s1');
    expect(state().isSidePanelOpen).toBe(false);
    state().toggleRightPanel();
    expect(state().isSidePanelOpen).toBe(false);
    expect(state().isActionPanelOpen).toBe(true);
  });

  // A background tab's memory goes too. It is mounted, so without this its
  // provider would still be publishing `true` and returning to that tab would
  // hand ⌘I a detail from before the trip.
  test("a background session's memory is wiped as well, not just the one being left", () => {
    state().setActiveSession('s1');
    state().setDetailContent('s2', true);
    state().setActiveSession('s3');
    expect(state()._detailContentBySession.s2).toBeUndefined();
  });

  // Re-activating the same session is a no-op, so a minimised detail is safe
  // from a layout effect that happens to re-run.
  test('re-activating the same session keeps the restore memory', () => {
    state().setActiveSession('s1');
    state().setDetailContent('s1', true);
    state().setActiveSession('s1');
    expect(state()._detailContentBySession.s1).toBe(true);
  });
});
