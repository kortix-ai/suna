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
});

describe('SessionSiteHeader trailing cluster — non-technical resting state', () => {
  test('Terminal, Browser, and Files are grouped behind a single "Developer tools" control, not three bare icon buttons', () => {
    // Exactly one Hint trigger carries the "Developer tools" label — the
    // three surfaces live inside its menu, not as standalone header buttons.
    const devToolsMatches = source.split('delayDuration={300} label="Developer tools"').length - 1;
    expect(devToolsMatches).toBe(1);

    const devToolsMenuStart = source.indexOf('label="Developer tools"');
    const devToolsMenuEnd = source.indexOf('</DropdownMenu>', devToolsMenuStart);
    const devToolsMenu = source.slice(devToolsMenuStart, devToolsMenuEnd);

    // Each surface still calls the same reachable entry point as before, so
    // nothing that worked stops working — it just costs one extra tap.
    expect(devToolsMenu).toContain("openSessionQuickView('terminal', 'header')");
    expect(devToolsMenu).toContain("openSessionQuickView('browser', 'header')");
    expect(devToolsMenu).toContain("openSessionQuickView('files', 'header')");
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
    const deleteIndex = source.indexOf('<TrashSolid');
    const exportIndex = source.indexOf('Export conversation');
    const compactIndex = source.indexOf('Summarize conversation');
    const renameIndex = source.indexOf(
      "'autoFeaturesSessionHeaderSessionSiteHeaderJsxTextRename41731a53'",
    );

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
    const exportItem = source.slice(
      Math.max(0, exportItemStart),
      source.indexOf('Export conversation'),
    );
    expect(exportItem).toContain('text-muted-foreground');

    const compactItemStart = source.indexOf('Summarize conversation') - 400;
    const compactItem = source.slice(
      Math.max(0, compactItemStart),
      source.indexOf('Summarize conversation'),
    );
    expect(compactItem).toContain('text-muted-foreground');
  });
});
