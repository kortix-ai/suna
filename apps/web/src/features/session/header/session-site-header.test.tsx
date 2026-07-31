import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('./session-site-header.tsx', import.meta.url)),
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

  test('the panel toggle stays the last control in the trailing cluster', () => {
    const panelToggleIndex = source.lastIndexOf('PanelRight');
    const devToolsIndex = source.indexOf('label="Developer tools"');
    const moreMenuIndex = source.indexOf('MoreHorizontal');
    expect(panelToggleIndex).toBeGreaterThan(devToolsIndex);
    expect(panelToggleIndex).toBeGreaterThan(moreMenuIndex);
  });
});

describe('SessionSiteHeader "more actions" menu — destructive last, technical items subordinate', () => {
  test('Delete is the last item and the only variant="destructive" entry', () => {
    const destructiveMatches = source.match(/variant="destructive"/g) ?? [];
    expect(destructiveMatches.length).toBe(1);

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
