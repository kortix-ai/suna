import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('./session-site-header.tsx', import.meta.url)),
  'utf8',
);
const exportModalSource = readFileSync(
  fileURLToPath(new URL('./export-transcript-modal.tsx', import.meta.url)),
  'utf8',
);

describe('SessionSiteHeader sidebar toggle', () => {
  test('connects collapsed-toggle hover to the sidebar peek controller', () => {
    expect(source).toContain('onPointerEnter={sidebarState ===');
    expect(source).toContain('peekEnter');
    expect(source).toContain('peekLeave');
  });

  // The collapse control lives in the panel's own header now
  // (ProjectSidebar), so this one exists purely to bring a hidden panel back.
  // Rendering it while the panel is docked would put two toggles for one
  // panel on screen at once.
  test('the toggle self-hides while the sidebar is docked open', () => {
    const gate = source.slice(
      source.indexOf('const showSidebarToggle ='),
      source.indexOf(';', source.indexOf('const showSidebarToggle =')),
    );
    expect(gate).toContain("sidebarState !== 'expanded'");
    expect(source).toContain('{showSidebarToggle && (');
  });

  // `sidebarState` tracks the desktop dock cookie, not the mobile Sheet — so
  // an ungated `!== 'expanded'` would strand mobile with no way to open it.
  test('mobile is exempt from that gate', () => {
    const gate = source.slice(
      source.indexOf('const showSidebarToggle ='),
      source.indexOf(';', source.indexOf('const showSidebarToggle =')),
    );
    expect(gate).toContain('isMobileViewport ||');
  });
});

describe('SessionSiteHeader transcript ownership', () => {
  test('keeps the export modal on the canonical project-session cache scope', () => {
    expect(source).toContain(
      'kortixSessionScope={isProjectSession ? `${projectId}/${projectSessionId}` : undefined}',
    );
    expect(exportModalSource).toContain(
      'useSessionSync(sessionId, { kortixSessionScope })',
    );
  });
});

describe('SessionSiteHeader trailing cluster — non-technical resting state', () => {
  test('Terminal, Browser, and Files come from one list, and collapse behind a single "Developer tools" control below lg', () => {
    // One declaration drives both the desktop row and the collapsed menu, so
    // a fourth surface is a one-line add that cannot land in only one of them.
    const devToolsList = source.slice(
      source.indexOf('const DEV_TOOLS'),
      source.indexOf('interface SessionSiteHeaderProps'),
    );
    expect(devToolsList).toContain("view: 'terminal'");
    expect(devToolsList).toContain("view: 'browser'");
    expect(devToolsList).toContain("view: 'files'");

    // Exactly one Hint trigger carries the "Developer tools" label, and it is
    // the below-lg collapse — on lg+ the surfaces are their own buttons.
    const devToolsMatches = source.split('delayDuration={300} label="Developer tools"').length - 1;
    expect(devToolsMatches).toBe(1);

    const devToolsMenuStart = source.indexOf('label="Developer tools"');
    const devToolsMenuEnd = source.indexOf('</DropdownMenu>', devToolsMenuStart);
    const devToolsMenu = source.slice(devToolsMenuStart, devToolsMenuEnd);
    expect(devToolsMenu).toContain('lg:hidden');

    // Both renderings reach the same entry point as before, so nothing that
    // worked stops working — below lg it just costs one extra tap.
    const desktopRowStart = source.indexOf('<div className="hidden items-center gap-1.5 lg:flex">');
    expect(desktopRowStart).toBeGreaterThan(-1);
    const desktopRow = source.slice(desktopRowStart, devToolsMenuStart);

    for (const block of [desktopRow, devToolsMenu]) {
      expect(block).toContain('DEV_TOOLS.map');
      expect(block).toContain("openSessionQuickView(view, 'header')");
    }
  });

  test('the changes and approvals indicators render before the grouped controls', () => {
    const changesIndex = source.indexOf('<SessionChangesIndicator');
    const approvalsIndex = source.indexOf('<SessionPendingApprovalsIndicator');
    const devToolsIndex = source.indexOf('label="Developer tools"');
    expect(changesIndex).toBeGreaterThan(-1);
    expect(approvalsIndex).toBeGreaterThan(changesIndex);
    expect(devToolsIndex).toBeGreaterThan(approvalsIndex);
  });

  // The side-panel toggle used to live here, last in the trailing cluster.
  // It is gone: the right-hand panel is a pure DETAIL view now, opened by
  // whatever gives it something to show and closed by its own X or Escape, so
  // a button that opened it empty had nothing to open it to. The floating
  // action panel carries its own chevron over the chat instead — along with
  // the ready-chip dot this button used to wear.
  test('the header no longer carries a side-panel toggle', () => {
    expect(source).not.toContain('PanelRight');
    expect(source).not.toContain('onToggleSidePanel');
    expect(source).not.toContain('isSidePanelOpen');
  });

  // Below 768px there is no room for a column beside the chat, so the cards
  // live in the bottom drawer and this is the only way into them. Gated on the
  // viewport, not a CSS breakpoint class, so it can never coexist with the
  // desktop column's own chevron.
  test('the header carries a mobile-only action-panel toggle', () => {
    expect(source).toContain('isMobileViewport && (');
    expect(source).toContain('toggleActionPanel');
    expect(source).toContain('CaretDoubleLeftIcon');
  });

  test('that toggle drives the action panel, never the detail panel', () => {
    expect(source).toContain('useIsActionPanelOpen');
    expect(source).not.toContain('setIsSidePanelOpen');
    expect(source).not.toContain('openSidePanel');
  });

  test('the ready-chip badge rides on it, and clears with it', () => {
    expect(source).toContain('readyChip?.sessionId === sessionId && !isActionPanelOpen');
    expect(source).toContain('bg-kortix-green');
  });
});

describe('SessionSiteHeader "more actions" menu — Delete last, technical items subordinate', () => {
  test('Delete is the last item and no row is styled destructive', () => {
    // Delete opens SessionDeleteModal; the click itself destroys nothing, so
    // the red belongs on the dialog's confirm button, not on a menu row that
    // only asks a question. Position still carries the weight here — Delete
    // sits last, where a slipped pointer lands on nothing worse.
    const destructiveMatches = source.match(/variant="destructive"/g) ?? [];
    expect(destructiveMatches.length).toBe(0);

    // `Delete` also appears earlier as a substring of the `SessionDeleteModal`
    // import — anchor on the destructive button's own icon instead.
    const deleteIndex = source.indexOf('<TrashIcon');
    const exportIndex = source.indexOf('Export conversation');
    const compactIndex = source.indexOf('Summarize conversation');
    const renameIndex = source.indexOf("'autoFeaturesSessionHeaderSessionSiteHeaderJsxTextRename41731a53'");

    expect(deleteIndex).toBeGreaterThan(exportIndex);
    expect(deleteIndex).toBeGreaterThan(compactIndex);
    expect(exportIndex).toBeGreaterThan(renameIndex);
  });

  test('Export and Summarize items are renamed to plain language and styled as visually subordinate', () => {
    // "Compact session" / "Export transcript" were the jargon-y labels the
    // brief called out by name — they must not survive under those names.
    expect(source).not.toContain('Compact session');
    expect(source).not.toContain('Export transcript');
    expect(source).toContain('Export conversation');
    expect(source).toContain('Summarize conversation');

    const exportItemStart = source.indexOf('Export conversation') - 400;
    const exportItem = source.slice(Math.max(0, exportItemStart), source.indexOf('Export conversation'));
    expect(exportItem).toContain('text-muted-foreground');

    const compactItemStart = source.indexOf('Summarize conversation') - 400;
    const compactItem = source.slice(Math.max(0, compactItemStart), source.indexOf('Summarize conversation'));
    expect(compactItem).toContain('text-muted-foreground');
  });
});

/**
 * The stale-config chip, wired.
 *
 * These are wiring assertions, not rendering ones, and they exist because of a
 * specific near-miss: `ConnectorRequiredNotice` shipped correct, passed every
 * unit test, and rendered nothing for weeks — it was mounted with a value the
 * app never populates. Its unit tests all covered the pure copy helper, which
 * was fine the whole time. The lesson is that for this component family the
 * bug lives at the mount, so the mount is what gets pinned.
 */
describe('SessionConfigIndicator wiring', () => {
  test('the chip gets the Kortix session id, never the OpenCode one', () => {
    // The header holds both. `sessionId` is the OpenCode id used by the
    // changes/approvals chips; the config routes are keyed on the project
    // session row's UUID, and passing the wrong one 400s on the id regex.
    const mount = source.split('<SessionConfigIndicator')[1]?.split('/>')[0];
    expect(mount).toBeTruthy();
    expect(mount).toContain('sessionId={projectSessionId!}');
    expect(mount).not.toContain('sessionId={sessionId}');
  });

  test('both reload entry points are gated on canShare', () => {
    // The route requires session-owner-or-project-manager and 403s otherwise,
    // so an ungated control is a button that only ever fails.
    const mount = source.split('<SessionConfigIndicator')[1]?.split('/>')[0];
    expect(mount).toContain('canReload={canShare}');

    const menuItem = source.slice(
      source.lastIndexOf('{canShare && (', source.indexOf('Reload config')),
      source.indexOf('Reload config'),
    );
    expect(menuItem).toContain('reloadConfig.reload()');
  });

  test('the ⋯ item and the chip share ONE mutation, so pending state cannot disagree', () => {
    expect(source).toContain('const reloadConfig = useReloadSessionConfig(');
    expect(source).toContain('isPending={reloadConfig.isPending}');
    expect(source).toContain('disabled={reloadConfig.isPending}');
  });

  test('the force confirm is mounted by the HEADER, not the chip', () => {
    // The chip unmounts the moment a reload lands (it self-hides when fresh).
    // A confirm dialog living inside it would vanish mid-question.
    expect(source).toContain('<SessionConfigReloadConfirm');
    const confirm = source.split('<SessionConfigReloadConfirm')[1]?.split('/>')[0];
    expect(confirm).toContain('busyReason={reloadConfig.busyReason}');
    expect(confirm).toContain("reloadConfig.reload({ force: true })");
  });

  test('Reload config is distinct from Restart and sits beside it', () => {
    // Two different actions on the same object: Restart reboots the same
    // config, Reload fetches a new one. Adjacent so the difference is legible.
    expect(source).toContain('Reload config');
    expect(source.indexOf('Restart')).toBeLessThan(source.indexOf('Reload config'));
  });
});
