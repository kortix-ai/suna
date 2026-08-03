import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * There is no ⌘I / Ctrl+I shortcut. Owner direction: each panel is opened by
 * its own control and by nothing else.
 *
 * It used to toggle the right-hand panel. That panel is content-driven now — it
 * opens because something gave it a terminal, a browser, a file or a step to
 * show, and closes with its own X or Escape, so there is no "open it empty"
 * state for a key to reach. The floating action panel has its chevron in the
 * chat. Neither needs a hotkey, and a hotkey that opened one of them would be a
 * second, invisible way to reach a surface that already has a visible one.
 *
 * Source assertions rather than a mounted layout: `session-layout.tsx` needs the
 * whole session runtime to render, and what is worth pinning is that no binding
 * exists at all. Same approach, and same reason, as
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

describe('no panel keyboard shortcut', () => {
  test('the layout binds no i-key handler', () => {
    expect(layout).not.toContain("e.key === 'i'");
    expect(layout).not.toContain("e.key === 'I'");
    expect(layout).not.toContain('shouldHandleHotkey');
  });

  test('the layout registers no keydown listener at all', () => {
    expect(layout).not.toContain("addEventListener('keydown'");
  });

  test('nothing advertises a shortcut on either panel control', () => {
    // The Advanced-mode panel header used to render a `⌘I` Kbd beside its
    // "Open/Close panel" tooltip, and the chevron briefly carried one too.
    expect(layout).not.toContain('<Kbd');
    expect(layout).not.toContain('line185JsxTextI');
    expect(column).not.toContain('<Kbd');
  });

  test('the chevron is the floating panel only opener', () => {
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
