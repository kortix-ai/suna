import { describe, expect, test } from 'bun:test';
import { readFileSync } from '@/i18n/test-source';
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
    expect(toggleAt).toBeLessThan(source.indexOf('{titleButton}'));
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
    const homeButtonIndex = source.indexOf('<Home ');
    expect(homeButtonIndex).toBeGreaterThan(-1);
    const titleIndex = source.indexOf('{titleButton}');
    const leadingActionIndex = source.lastIndexOf('{leadingAction}');
    expect(titleIndex).toBeGreaterThan(-1);
    expect(titleIndex).toBeGreaterThan(homeButtonIndex);
    expect(leadingActionIndex).toBeGreaterThan(titleIndex);
  });

  // Without these, a long title just grows the leading cluster and pushes
  // the trailing cluster (config/dev-tools/⋯) off-screen instead of eliding.
  test('the title element carries min-w-0 and truncate, so a long value shrinks instead of expanding the row', () => {
    const titleIndex = source.indexOf('>{headerTitle}</span>');
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

  // Split control: the name and the caret are two buttons. A click on the
  // name edits it in place; only the caret opens the session menu.
  test('the name is a plain button that starts the inline rename, not a menu trigger', () => {
    const titleIndex = source.indexOf('>{headerTitle}</span>');
    const nameButton = source.slice(source.lastIndexOf('<Button', titleIndex), titleIndex);
    expect(nameButton).toContain('onClick={startRename}');
    expect(nameButton).toContain('rounded-md');
    expect(nameButton).toContain('px-2.5');

    const triggerStart = source.indexOf('<DropdownMenuTrigger asChild>');
    expect(triggerStart).toBeGreaterThan(titleIndex);
  });

  test('the caret is its own menu trigger and never rotates', () => {
    const triggerStart = source.indexOf('<DropdownMenuTrigger asChild>');
    const trigger = source.slice(triggerStart, source.indexOf('</DropdownMenuTrigger>'));
    expect(trigger).toContain('size="icon-sm"');
    expect(trigger).toContain('aria-label=');
    expect(trigger).toContain('data-[state=open]:bg-card');
    expect(trigger).toContain('<CaretDownIcon');
    expect(trigger).not.toContain('rotate-180');
    expect(trigger).not.toContain('{headerTitle}');
  });

  test('renaming swaps the name for the inline field, which saves through the shared hook', () => {
    expect(source).toContain('<SessionTitleInput');
    expect(source).toContain('useRenameSession(');
    expect(source).toContain('renameMutation.mutate(name)');
    // One rename surface: the modal is gone from the header.
    expect(source).not.toContain('<RenameSessionModal');
  });

  test('the menu Rename item keeps focus in the field Radix would steal back', () => {
    expect(source).toContain('renameFromMenu.current = true;');
    const content = source.slice(source.indexOf('<DropdownMenuContent\n'));
    expect(content).toContain('onCloseAutoFocus');
    expect(content).toContain('e.preventDefault()');
  });

  test('uses the complete action list in the title menu', () => {
    expect(source.split('{sessionActionItems}').length - 1).toBe(1);
    expect(source).toContain('startRename();');
    expect(source).toContain('restartMutation.mutate()');
    expect(source).toContain('reloadConfig.reload()');
    expect(source).toContain('stopMutation.mutate()');
    expect(source).toContain('setExportOpen(true)');
    expect(source).toContain('setCompactOpen(true)');
    expect(source).toContain('setDeleteOpen(true)');
  });

  // KRTX-801: the desktop shell has no address bar, so the menu copies the
  // session ID and link. The ID is the project session from the URL, not the
  // runtime `sessionId` prop; the link is read at click time.
  test('copies the project session ID and the current link through the shared clipboard helper', () => {
    expect(source).toContain("copyValue(tPalette('copySessionId'), projectSessionId!)");
    expect(source).toContain("copyValue(tPalette('copySessionLink'), window.location.href)");
    expect(source).toContain('copyToClipboard(value)');
    expect(source.indexOf("tPalette('copySessionId')")).toBeLessThan(
      source.indexOf('setExportOpen(true)'),
    );
  });
});

/**
 * A subsession shows its parent as the first breadcrumb: home icon and parent
 * name, a slash, then the subsession's own name control. The parent link used
 * to sit above the composer; it lives only here now.
 */
const cardSource = readFileSync(
  fileURLToPath(new URL('./subagent-hover-card.tsx', import.meta.url)),
  'utf8',
);

describe('SessionSiteHeader subsession breadcrumb', () => {
  const composerSource = readFileSync(
    fileURLToPath(new URL('../composer/composer.tsx', import.meta.url)),
    'utf8',
  );

  test('the parent crumb renders after the sidebar toggle and before the session name', () => {
    const crumbAt = source.indexOf('onClick={parent.onOpen}');
    expect(crumbAt).toBeGreaterThan(source.indexOf('<SidebarToggle />'));
    expect(crumbAt).toBeLessThan(source.indexOf('{titleButton}'));
    const crumb = source.slice(crumbAt, source.indexOf('</Button>', crumbAt));
    // The custom filled house mark, not the Phosphor outline.
    expect(crumb).toContain('<Home ');
    expect(source).toContain("import { Home } from '@/features/icon/icons/home';");
    // Reads "Home", never the parent session's title.
    expect(crumb).toContain("'i18nComplete.text3a78695388b3'");
    expect(source).not.toContain('parent.title');
  });

  // `projectSession` is the PARENT's row on a subsession route, so its name and
  // its rename must not leak onto the subsession's crumb.
  test("a subsession shows its own title, not the project session's, and cannot rename it", () => {
    expect(source).toContain('const headerTitle = parent');
    expect(source).toContain('const canRename = isProjectSession && !!projectSession && !parent;');
    const menuStart = source.indexOf('const sessionActionItems = (');
    const renameItem = source.indexOf('startRename();', menuStart);
    expect(source.lastIndexOf('{canRename && (', renameItem)).toBeGreaterThan(menuStart);
    // Delete removes the whole project session, so it names that session.
    expect(source).toContain('sessionLabel={projectTitle}');
  });

  test('the subagent suffix is stripped from the subsession title', () => {
    expect(source).toContain('? subagentTitle(sessionTitle)');
    const pattern = cardSource.match(/title\.replace\((\/.*\/), ''\)/)?.[1];
    expect(pattern).toBeTruthy();
    const re = new Function(`return ${pattern}`)() as RegExp;
    expect('Research the topic (@general subagent)'.replace(re, '')).toBe('Research the topic');
    expect('Plain title'.replace(re, '')).toBe('Plain title');
  });

  test('the composer no longer carries a back-to-parent control', () => {
    expect(composerSource).not.toContain('threadContext');
    expect(composerSource).not.toContain('onBackToParent');
  });
});

/**
 * A parent session's name, on hover, lists the subagents it spawned. Only on a
 * root session with children: a subsession has its own crumb, and a session
 * with no children keeps the plain "Rename" hint.
 */
describe('SessionSiteHeader subagent hover card', () => {
  test('wraps the name only on a root session that has subsessions', () => {
    expect(source).toContain(
      'const subsessions = projectSession && !parent ? directSubsessions(projectSession) : [];',
    );
    const cardAt = source.indexOf('<SubagentHoverCard');
    expect(source.lastIndexOf('canRename && subsessions.length > 0 ? (', cardAt)).toBeGreaterThan(-1);
    expect(source.slice(cardAt, source.indexOf('</SubagentHoverCard>'))).toContain('{titleButton}');
    // The Rename hint still wraps the same button when there are no children.
    const cardEnd = source.indexOf('</SubagentHoverCard>');
    const hintAt = source.indexOf('{titleButton}', cardEnd);
    expect(source.lastIndexOf('<Hint', hintAt)).toBeGreaterThan(cardEnd);
  });

  test('the card uses the HoverCard primitive and links each row to its child-session route', () => {
    expect(cardSource).toContain("from '@/components/ui/hover-card'");
    expect(cardSource).toContain('href={childSessionHref(href, child.id)}');
    expect(cardSource).toContain('<HoverPrefetchLink');
    expect(cardSource).toContain("menuRow('sm', 'default'");
    // A row click closes the card before the route changes under it.
    expect(cardSource).toContain('onClick={() => setOpen(false)}');
    expect(cardSource).toContain('animated={false}');
  });

  test('a long list scrolls inside a capped, edge-faded area', () => {
    const area = cardSource.slice(cardSource.indexOf('<FadedScrollArea'), cardSource.indexOf('<ul'));
    expect(area).toContain('max-h-64');
    expect(area).toContain('overscroll-contain');
    expect(area).toContain('fadeColor="from-popover"');
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
    const devToolsMatches =
      source.match(/delayDuration=\{300\}[\s\S]{0,150}text96f0c06bbcb7/g)?.length ?? 0;
    expect(devToolsMatches).toBe(1);

    const devToolsMenuStart = source.indexOf('text96f0c06bbcb7');
    const devToolsMenuEnd = source.indexOf('</DropdownMenu>', devToolsMenuStart);
    const devToolsMenu = source.slice(devToolsMenuStart, devToolsMenuEnd);
    expect(devToolsMenu).toContain('lg:hidden');

    // Both renderings reach the same entry point as before, so nothing that
    // worked stops working — below lg it just costs one extra tap.
    const desktopRowStart = source.indexOf('<div className="hidden items-center gap-1.5 lg:flex">');
    expect(desktopRowStart).toBeGreaterThan(-1);
    const desktopRow = source.slice(desktopRowStart, devToolsMenuStart);

    for (const block of [desktopRow, devToolsMenu]) {
      expect(block).toContain('devTools.map');
      expect(block).toContain("openSessionQuickView(view, 'header')");
    }
  });

  test('the changes and approvals indicators render before the grouped controls', () => {
    const changesIndex = source.indexOf('<SessionChangesIndicator');
    const approvalsIndex = source.indexOf('<SessionPendingApprovalsIndicator');
    const devToolsIndex = source.indexOf('text96f0c06bbcb7');
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

  test('Export and Summarize items are renamed to plain language', () => {
    // "Compact session" / "Export transcript" were the jargon-y labels the
    // brief called out by name — they must not survive under those names.
    // The items render in the plain menu style (#9169), not muted.
    expect(source).not.toContain('Compact session');
    expect(source).not.toContain('Export transcript');
    expect(source).toContain('Export conversation');
    expect(source).toContain('Summarize conversation');
  });
});

/**
 * The stale-config chip, wired.
 *
 * These are wiring assertions, not rendering ones, and they exist because of a
 * specific near-miss: a sibling inline card (`ConnectorRequiredNotice`, since
 * removed — connector-credentials rework) shipped correct, passed every unit
 * test, and rendered nothing for weeks — it was mounted with a value the app
 * never populates. Its unit tests all covered the pure copy helper, which was
 * fine the whole time. The lesson is that for this component family the bug
 * lives at the mount, so the mount is what gets pinned.
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
    expect(source).toContain('projectSession.can_manage_sharing !== false');
    expect(source).toContain('projectSession.can_manage_lifecycle !== false');
    // Stop is lifecycle. It must not ride on the sharing verdict. The status
    // half lives in `sessionCanBeStopped` (a warm shell reported
    // `provisioning` keeps its Stop control, KRTX-1466); the lifecycle
    // verdict stays here.
    expect(source).toContain('sessionCanBeStopped(projectSession) && canManageLifecycle');
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

describe('SessionSiteHeader Share', () => {
  const menuStart = source.indexOf('const sessionActionItems = (');
  const menu = source.slice(menuStart, source.indexOf('\n  );', menuStart));

  test('Share is a visible header button, not a session-menu item', () => {
    // Anti-vacuity guard: prove the slice is the menu.
    expect(menu).toContain('startRename();');
    expect(menu).not.toContain('setShareOpen(true)');
    expect(source.split('setShareOpen(true)').length - 1).toBe(1);
    const button = source.slice(
      source.lastIndexOf('<Button', source.indexOf('setShareOpen(true)')),
      source.indexOf('</Button>', source.indexOf('setShareOpen(true)')),
    );
    expect(button).toContain('<Share ');
    // The visible label is "Share"; below `sm` the button is icon-only and
    // keeps its accessible name.
    expect(button).toContain("'i18nComplete.text29887a5ff984'");
    expect(button).toContain('aria-label={shareLabel}');
  });

  test('the participant stack sits directly before Share and opens nothing', () => {
    const stack = source.indexOf('<SessionParticipantStack');
    const share = source.indexOf('setShareOpen(true)');
    expect(stack).toBeGreaterThan(-1);
    expect(stack).toBeLessThan(share);
    // Nothing else renders between the stack and the Share button's guard.
    const between = source.slice(source.indexOf('/>', stack), source.lastIndexOf('<Hint', share));
    expect(between.replace(/\s/g, '')).toBe('/>)}{isProjectSession&&projectSession&&(');
    const element = source.slice(stack, source.indexOf('/>', stack));
    expect(element).toContain('participants={sessionParticipants}');
    expect(element).not.toContain('Open');
  });

  test('the button needs a loaded project session, like the dialog it opens', () => {
    const at = source.indexOf('setShareOpen(true)');
    const guard = source.lastIndexOf('{isProjectSession && projectSession && (', at);
    expect(guard).toBeGreaterThan(-1);
    expect(at - guard).toBeLessThan(800);
  });

  test('matches the 28px row: xs, square when icon-only, and a Hint only then', () => {
    const at = source.indexOf('setShareOpen(true)');
    const hint = source.slice(source.lastIndexOf('<Hint', at), at);
    expect(hint).toContain('open={isMobileViewport ? undefined : false}');
    expect(hint).toContain('label={shareLabel}');
    const button = source.slice(source.lastIndexOf('<Button', at), source.indexOf('</Button>', at));
    expect(button).toContain('size="xs"');
    expect(button).toContain('max-md:w-7 max-md:has-[>svg]:px-0');
    // The label hides at the same breakpoint the Hint turns on.
    expect(button).toContain('hidden md:inline');
    expect(button).toContain('<Share />');
  });
});

describe('SessionSiteHeader Fork', () => {
  const menuStart = source.indexOf('const sessionActionItems = (');
  const menu = source.slice(menuStart, source.indexOf('\n  );', menuStart));

  // `session.fork` is a runtime capability (OpenCode serves it, pi does not),
  // and the fork belongs to a project session's conversation: a share viewer
  // or instant shell has no route to open the fork on.
  test('the Fork item is gated on the runtime capability and the project session', () => {
    expect(source).toContain("useRuntimeSupports('session.fork') && isProjectSession");
    const item = menu.slice(menu.indexOf('{canFork && ('));
    expect(item.slice(0, item.indexOf('</>'))).toContain('i18nComplete.text0e5f7f6732e0');
  });

  test('Fork is one mutation, disabled while pending, like the other items', () => {
    expect(source).toContain('const forkSession = useForkSession(');
    const item = menu.slice(menu.indexOf('{canFork && ('));
    expect(item).toContain('disabled={forkSession.isPending}');
    expect(item).toContain('forkSession.mutate(\n                  { sessionId },');
  });

  test('a forked conversation opens on the same project-session route', () => {
    expect(source).toContain('childSessionHref(');
    expect(source).toContain('/projects/${projectId}/sessions/${projectSessionId}`');
  });

  // Conversation actions group: Fork branches the transcript, so it reads
  // beside Export/Summarize, not beside the lifecycle verbs above the divider.
  test('Fork sits in the conversation group, before Export conversation', () => {
    const forkAt = menu.indexOf('text0e5f7f6732e0');
    const exportAt = menu.indexOf('text5d974f9e80c3');
    expect(forkAt).toBeGreaterThan(-1);
    expect(exportAt).toBeGreaterThan(forkAt);
  });
});

/**
 * KRTX-1742: the session menu mutes and unmutes this session's notifications
 * for the caller. The item waits for the watch read, so it never shows the
 * wrong verb, and a subsession (whose row is its parent's) has none. With the
 * project's `notification_center` flag off there is no read and no item.
 */
describe('SessionSiteHeader mute notifications', () => {
  const menu = source.slice(source.indexOf('const sessionActionItems = ('));

  test('the watch is read for the project session, never for a subsession', () => {
    expect(source).toContain('useSessionWatch({');
    expect(source).toContain('enabled: isProjectSession && !parent && notificationCenter,');
  });

  test('the flag gates the read and the item', () => {
    expect(source).toContain('const notificationCenter = useNotificationCenter(projectId);');
    expect(source).toContain(
      'const watching = notificationCenter ? sessionWatch.data?.watching : undefined;',
    );
  });

  test('the item shows once the watch is known, and names the next state', () => {
    const item = menu.slice(menu.indexOf('{watching !== undefined && ('));
    expect(item).toContain('onClick={toggleWatch}');
    expect(item).toContain("watching ? tNotifications('session.mute') : tNotifications('session.unmute')");
  });

  test('the toggle flips the watch and reports the result', () => {
    expect(source).toContain('.setWatching(!watching)');
    expect(source).toContain("tNotifications('session.muted')");
    expect(source).toContain("tNotifications('session.unmuted')");
  });
});
