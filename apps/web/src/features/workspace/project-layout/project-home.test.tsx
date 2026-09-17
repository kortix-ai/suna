import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./project-home.tsx', import.meta.url)), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('ProjectHome sidebar toggle', () => {
  // Neither the control nor its visibility is this view's decision any more.
  // It used to inline both: `isMobileViewport || sidebarState !== 'expanded'`
  // (true on the desktop shell too, so this `absolute top-2 left-2` button
  // rendered on top of the macOS traffic lights next to the shell's own opener
  // at x=72) plus its own copy of the button. `SidebarToggle` owns both —
  // pinned in sidebar-toggle.test.ts and sidebar-opener.test.ts.
  //
  // `floating` is the placement this hero needs: there is no header row to sit
  // in, so the opener positions itself over the wallpaper.
  test('renders the shared opener, floating over the hero', () => {
    expect(source).toContain('<SidebarToggle placement="floating" />');
  });

  test('keeps no opener of its own', () => {
    expect(code).not.toContain('toggleSidebar');
    expect(code).not.toContain('sidebarOpenerLabel');
    expect(code).not.toContain('useShowPageSidebarOpener');
  });

  test('does not send the project default as an explicit session sandbox override', () => {
    expect(source).not.toContain('sandbox_slug: activeSlug');
  });
});

describe('ProjectHome access-requests bell', () => {
  // `GET /projects/:id/access-requests` asserts project.members.manage, so
  // firing it for a member was a guaranteed 403. `showErrors: false` only hid
  // the toast; the request still went out and still failed.
  test('the pending-access bell probes members.manage before it fetches', () => {
    expect(code).toContain(
      'useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE).allowed === true',
    );
    const query = code.slice(
      code.indexOf('queryKey: qk.project.accessRequests(projectId)'),
      code.indexOf('const pendingAccessCount'),
    );
    expect(query).toContain('enabled: canManageMembers');
  });
});

describe('ProjectHome first chat starters', () => {
  // A render test cannot observe the prefill state these set, so the wiring is
  // pinned here and the submit itself in `composer-logic.test.ts`.
  test('"Update memory" submits its prompt through the composer', () => {
    expect(code).toContain(
      "setPrefill({ text: tFirstChat('memoryPrompt'), id: Date.now(), submit: true })",
    );
  });

  test('"Recommend tools" fills the composer without submitting', () => {
    expect(code).toContain("onRecommendTools={() => applySuggestion(tFirstChat('toolsPrompt'))}");
    const applySuggestion = code.slice(
      code.indexOf('const applySuggestion'),
      code.indexOf('const draftScope'),
    );
    expect(applySuggestion).toContain('setPrefill({ text: s, id: Date.now() })');
    expect(applySuggestion).not.toContain('submit');
  });
});
