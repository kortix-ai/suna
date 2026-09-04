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
  // This header used to carry its own eighteen-line copy of the opener — the
  // peek wiring, the label, the gate call, the ghost icon button. All of it is
  // `SidebarToggle` now (pinned in project-layout/sidebar-toggle.test.ts), and
  // the visibility rule it defers to is a truth table in sidebar-opener.test.ts.
  // The header's only remaining job is to place it, first in the leading
  // cluster, in flow — never absolute over the row.
  test('renders the shared opener, first in the leading cluster', () => {
    expect(source).toContain('<SidebarToggle />');
    const toggleAt = source.indexOf('<SidebarToggle />');
    expect(toggleAt).toBeGreaterThan(-1);
    expect(toggleAt).toBeLessThan(source.indexOf('{headerTitle}'));
  });

  // `sidebarState` survives for the title-bar indent (`sidebarHidden`), not
  // for a second opener. A `toggleSidebar` here means one grew back.
  test('keeps no opener of its own', () => {
    expect(source).not.toContain('toggleSidebar');
    expect(source).not.toContain('sidebarOpenerLabel');
  });
});

/**
 * The rendered name is `headerTitle`, not the `sessionTitle` prop: the prop
 * carries OPENCODE's own session.title, and the header must show the same name
 * as the sidebar row (see session-header-title.test.ts).
 */
describe('SessionSiteHeader session title', () => {
  test('renders the session name in the leading cluster, after the home button and before leadingAction', () => {
    const homeButtonIndex = source.indexOf('<HouseIcon');
    const titleIndex = source.indexOf('{headerTitle}');
    const leadingActionIndex = source.lastIndexOf('{leadingAction}');
    expect(titleIndex).toBeGreaterThan(-1);
    expect(titleIndex).toBeGreaterThan(homeButtonIndex);
    expect(leadingActionIndex).toBeGreaterThan(titleIndex);
  });

  // Without these, a long title just grows the leading cluster and pushes
  // the trailing cluster (config/dev-tools/⋯) off-screen instead of eliding.
  test('the title element carries min-w-0 and truncate, so a long value shrinks instead of expanding the row', () => {
    const titleIndex = source.indexOf('{headerTitle}');
    const titleTagStart = source.lastIndexOf('<span', titleIndex);
    const titleTag = source.slice(titleTagStart, titleIndex);
    expect(titleTag).toContain('min-w-0');
    expect(titleTag).toContain('truncate');
  });

  // The stray blank JSX expression that used to sit where the title now
  // renders is gone — the trailing cluster's first real child follows
  // directly after the opening tag.
  test('the dead blank line ahead of the trailing cluster is gone', () => {
    const trailingClusterStart = source.indexOf('<SessionChangesIndicator');
    const precedingChunk = source.slice(trailingClusterStart - 40, trailingClusterStart);
    expect(precedingChunk.trim().endsWith('>')).toBe(true);
  });

  test('renders the title and down caret as a padded dropdown trigger', () => {
    const titleIndex = source.indexOf('{headerTitle}');
    const triggerStart = source.lastIndexOf('<DropdownMenuTrigger', titleIndex);
    const trigger = source.slice(
      triggerStart,
      source.indexOf('</DropdownMenuTrigger>', titleIndex),
    );

    expect(triggerStart).toBeGreaterThan(-1);
    expect(trigger).toContain('rounded-md');
    expect(trigger).toContain('px-2.5');
    expect(trigger).toContain('py-1');
    expect(trigger).toContain('data-[state=open]:bg-card');
    expect(trigger).toContain('<CaretDownIcon');
    expect(trigger).toContain('group-data-[state=open]:rotate-180');
  });

  test('uses the complete action list in the title menu', () => {
    expect(source.split('{sessionActionItems}').length - 1).toBe(1);
    expect(source).toContain('setRenameOpen(true)');
    expect(source).toContain('setShareOpen(true)');
    expect(source).toContain('restartMutation.mutate()');
    expect(source).toContain('reloadConfig.reload()');
    expect(source).toContain('stopMutation.mutate()');
    expect(source).toContain('setExportOpen(true)');
    expect(source).toContain('setCompactOpen(true)');
    expect(source).toContain('setDeleteOpen(true)');
  });
});

describe('SessionSiteHeader transcript ownership', () => {
  test('keeps the export modal on the canonical project-session cache scope', () => {
    expect(source).toContain(
      'kortixSessionScope={isProjectSession ? `${projectId}/${projectSessionId}` : undefined}',
    );
    expect(exportModalSource).toContain('useSessionSync(sessionId, { kortixSessionScope })');
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
    expect(mount).toContain('chatSessionId={sessionId}');
    expect(mount).toContain('baseRef={projectSession?.base_ref}');
  });

  test('both reload entry points are gated on canManageLifecycle, NOT on sharing', () => {
    // The route requires session-owner-or-project-manager (mayChangeSessionModel
    // → canManageLifecycle) and 403s otherwise, so an ungated control is a
    // button that only ever fails.
    //
    // The name is the assertion. `can_manage_sharing` is a NARROWER verdict —
    // the owner's alone, since a manager who did not create a session must not
    // rewrite who can read it. Gating reload on that one would silently strip
    // Reload config and Stop from every project manager on a session they did
    // not create, which is a lifecycle right they still hold.
    const mount = source.split('<SessionConfigIndicator')[1]?.split('/>')[0];
    expect(mount).toContain('canReload={canManageLifecycle}');
    expect(mount).not.toContain('canReload={canManageSharing}');

    const menuItem = source.slice(
      source.lastIndexOf('{canManageLifecycle && (', source.indexOf('Reload config')),
      source.indexOf('Reload config'),
    );
    expect(menuItem).toContain('reloadConfig.reload()');
  });

  test('the two verdicts are read from their own fields, never one from the other', () => {
    // One flag used to answer both questions. Splitting it is the whole point;
    // a future edit that collapses them again reintroduces either a manager
    // rewriting another human's session sharing, or a manager who cannot stop
    // a runaway session they did not start.
    expect(source).toContain("projectSession.can_manage_sharing !== false");
    expect(source).toContain("projectSession.can_manage_lifecycle !== false");
    // Stop is lifecycle. It must not ride on the sharing verdict.
    expect(source).toContain("projectSession.status === 'running' && canManageLifecycle");
  });

  test('the ⋯ item and the chip share ONE mutation, so pending state cannot disagree', () => {
    expect(source).toContain('const reloadConfig = useReloadSessionConfig(');
    expect(source).toContain('isPending={reloadConfig.isPending}');
    expect(source).toContain('phase={reloadConfig.phase}');
    expect(source).toContain('disabled={reloadConfig.isPending}');
  });

  test('the force confirm is mounted by the HEADER, not the chip', () => {
    // The chip unmounts the moment a reload lands (it self-hides when fresh).
    // A confirm dialog living inside it would vanish mid-question.
    expect(source).toContain('<SessionConfigReloadConfirm');
    const confirm = source.split('<SessionConfigReloadConfirm')[1]?.split('/>')[0];
    expect(confirm).toContain('busyReason={reloadConfig.busyReason}');
    expect(confirm).toContain('reloadConfig.reload({ force: true })');
  });

  test('Reload config is distinct from Restart and sits beside it', () => {
    // Two different actions on the same object: Restart reboots the same
    // config, Reload fetches a new one. Adjacent so the difference is legible.
    expect(source).toContain('Reload config');
    expect(source.indexOf('Restart')).toBeLessThan(source.indexOf('Reload config'));
  });
});
