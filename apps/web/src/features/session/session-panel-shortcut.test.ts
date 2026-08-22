import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * ⌘I / Ctrl+I toggles the RIGHT SIDE of the session — whichever surface is
 * docked there: the action-panel column, a detail panel (browser, terminal,
 * files, a file preview), or both at once.
 *
 * It was bound to the action-panel column alone, which left every detail panel
 * with no keyboard close and made the key a no-visible-op while one was up.
 * The behavior itself lives in the store (`toggleRightPanel`, covered by
 * `stores/kortix-computer-store.test.ts`); what this file pins is that the
 * binding calls THAT and not the column's own toggle.
 *
 * Source assertions rather than a mounted layout: `session-layout.tsx` needs the
 * whole session runtime to render, and what is worth pinning is where the
 * binding lives. Same approach, and same reason, as
 * `header/session-site-header.test.tsx`.
 */
const layout = readFileSync(
  fileURLToPath(new URL('./session-layout.tsx', import.meta.url)),
  'utf8',
);
const column = readFileSync(
  fileURLToPath(new URL('./session-action-panel-column.tsx', import.meta.url)),
  'utf8',
);
const provider = readFileSync(
  fileURLToPath(new URL('./action-panel/session-panel-provider.tsx', import.meta.url)),
  'utf8',
);

describe('⌘I toggles the whole right side', () => {
  test('the column binds mod+i and registers a keydown listener', () => {
    expect(column).toContain("e.key === 'i'");
    expect(column).toContain("e.key === 'I'");
    expect(column).toContain('shouldHandleHotkey');
    expect(column).toContain("addEventListener('keydown'");
  });

  // The whole point of the change: the key reaches the store action that reads
  // BOTH surfaces, not the column's own single-surface toggle.
  test('the key calls toggleRightPanel, never the column-only toggle', () => {
    expect(column).toContain('useToggleRightPanel');
    expect(column).toContain('toggleRight()');
    const handler = column.slice(
      column.indexOf('const onKey = '),
      column.indexOf("addEventListener('keydown'"),
    );
    expect(handler).toContain('toggleRight()');
    // As a STATEMENT, not as prose: the handler carries a comment explaining
    // why it is not `toggle()`, and a substring check would fail on that.
    expect(handler).not.toMatch(/^\s*toggle\(\);/m);
  });

  // The chevron is this column's own control and must stay narrow — binding it
  // to the right-side toggle would make it close a detail it never opened.
  test('the chevron still moves only this column', () => {
    expect(column).toContain('useToggleActionPanel');
    expect(column).toContain('onClick={toggle}');
  });
});

/**
 * The ⌘I restore memory is SESSION-SCOPED, and the provider is what makes that
 * true in the React half: it keeps its detail through a ⌘I close (that is a
 * minimise, so the next press restores it) and drops it on a session change
 * (leave the page and the right side starts over).
 *
 * The store half — wiping `_detailContentBySession` in `setActiveSession` —
 * is covered by `stores/kortix-computer-store.test.ts`. Both exist on purpose:
 * the store guarantees the rule even if no provider is mounted.
 */
describe('the provider drops its detail on a session change, not on a close', () => {
  test('the effect is keyed on the active session and clears detail + terminal', () => {
    const effect = provider.slice(provider.indexOf('const activeSessionId'));
    expect(effect).toContain('s._activeSessionId');
    expect(effect).toContain('setDetail(');
    expect(effect).toContain('setTerminalOpen(');
    expect(effect).toContain('}, [activeSessionId]);');
  });

  // The close path must NOT clear it — that is what makes ⌘I a minimise. If
  // this effect ever keyed on `isSidePanelOpen`, the restore would silently
  // become "reopen an empty panel".
  test('it does not key on the panel-open flag', () => {
    const effect = provider.slice(
      provider.indexOf('const activeSessionId'),
      provider.indexOf('}, [activeSessionId]);'),
    );
    expect(effect).not.toContain('isSidePanelOpen');
  });

  test('it publishes the content session-keyed, so ⌘I knows what to restore', () => {
    expect(provider).toContain('setDetailContent(sessionId, detail !== null || terminalOpen)');
  });

  // An unmounted provider has no detail, so a `true` left in the map would
  // promise ⌘I something that no longer exists.
  test('it forgets the session on unmount', () => {
    expect(provider).toContain('setDetailContent(sessionId, null)');
  });

  test('only the active session tab owns the shortcut', () => {
    expect(column).toContain('isInTabSystem ? isActiveTab : true');
    expect(column).toContain('useTabStore');
  });

  test('the layout does not also bind the same key', () => {
    expect(layout).not.toContain("e.key === 'i'");
    expect(layout).not.toContain("e.key === 'I'");
    expect(layout).not.toContain('shouldHandleHotkey');
    expect(layout).not.toContain("addEventListener('keydown'");
  });

  test('the chevron advertises the shortcut', () => {
    expect(column).toContain('<Kbd');
    expect(column).toContain('modSymbol');
  });

  test('the chevron still toggles the floating panel', () => {
    expect(column).toContain('useToggleActionPanel');
    expect(column).toContain('CaretDoubleLeftIcon');
    expect(column).toContain('CaretDoubleRightIcon');
  });
});

/**
 * Mobile keeps both surfaces in one drawer — a bottom sheet pulling up from the
 * base of the screen, not a side sheet — because there is no room beside a
 * 375px chat for a column. The states stay independent everywhere else; here
 * they share a container.
 *
 * This exists because deleting the header's old panel toggle briefly left
 * mobile with NO way to open the panel at all: the drawer keyed off
 * `isSidePanelOpen`, and nothing user-facing set it any more.
 */
describe('mobile drawer hosts both surfaces', () => {
  test('the drawer opens when either surface is open', () => {
    expect(layout).toContain('isSidePanelOpen || isActionPanelOpen');
    expect(layout).toContain('open={shouldShowMobilePanel}');
  });

  test('dismissing it puts both down, so neither replays on the next open', () => {
    expect(layout).toContain('handleMobilePanelClose');
    const fn = layout.slice(layout.indexOf('const handleMobilePanelClose'), layout.indexOf('const handleMobilePanelClose') + 220);
    expect(fn).toContain('handleSidePanelClose()');
    expect(fn).toContain('setIsActionPanelOpen(false)');
  });

  test('the desktop split still keys off the detail panel alone', () => {
    expect(layout).toContain('const shouldShowPanel = isSidePanelOpen;');
  });
});

describe('the collapse control gets out of the way when expanded', () => {
  test('it fades out while open and returns on column hover or focus', () => {
    expect(column).toContain('group/panel');
    expect(column).toContain('group-hover/panel:opacity-100');
    expect(column).toContain('focus-visible:opacity-100');
  });

  // Opacity zero still occupies space AND still receives pointer events, so a
  // faded button stays clickable — an invisible hit target against the panel
  // edge. Pointer events must ride with the fade, both directions.
  test('pointer events ride with the fade, not just the opacity', () => {
    expect(column).toContain('pointer-events-none opacity-0');
    expect(column).toContain('group-hover/panel:pointer-events-auto');
    expect(column).toContain('focus-visible:pointer-events-auto');
  });

  test('closed, it is always visible — the hide set is gated on isOpen', () => {
    // Matches either form the gate has taken (`isOpen && '…'` or
    // `isOpen ? '…' : '…'`), so a reformat does not silently void this.
    const hide = column.indexOf('pointer-events-none opacity-0');
    expect(hide).toBeGreaterThan(-1);
    const gate = column.lastIndexOf('isOpen', hide);
    expect(gate).toBeGreaterThan(-1);
    expect(column.slice(gate, hide)).toMatch(/^isOpen\s*[?&]/);
  });
});

/**
 * While a detail panel is up — browser, terminal, files, a file preview — the
 * action panel column steps aside entirely. Chat plus the one thing being
 * looked at, never a transcript squeezed between two panels.
 *
 * Hiding only the chevron would be worse than leaving it visible: with the
 * cards expanded there would be no control left to collapse them.
 */
describe('the action panel yields to an open detail panel', () => {
  test('the column hides while a detail panel is open', () => {
    expect(column).toContain('useIsSidePanelOpen');
    expect(column).toContain("detailPanelOpen && 'hidden'");
  });

  test('it hides the whole column, not just the control', () => {
    // The gate sits on the column's own className, so the chevron AND the
    // cards go together. If it had been applied to the button alone, this
    // string would live inside the button's `cn(...)` instead.
    const colClass = column.indexOf("'group/panel flex");
    const buttonClass = column.indexOf("'flex size-7 shrink-0");
    const gate = column.indexOf("detailPanelOpen && 'hidden'");
    expect(gate).toBeGreaterThan(colClass);
    expect(gate).toBeLessThan(buttonClass);
  });

  // The two open-states stay independent — this is a RENDER rule. Writing
  // `setIsActionPanelOpen(false)` here would couple them and lose the user's
  // choice, so closing the detail could not restore what they had.
  test('it writes no state — the column returns as the user left it', () => {
    // The trailing paren matters: both names appear in prose above, and this
    // must assert there is no CALL, not that the words are absent.
    expect(column).not.toContain('setIsActionPanelOpen(');
    expect(column).not.toContain('setIsSidePanelOpen(');
    expect(column).not.toContain('toggleActionPanel()');
  });
});
