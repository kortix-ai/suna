import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The sidebar has two groups around the session list.
 *
 * Top: New session, then the customizable nav rows (`ProjectNavItems`:
 * Customize, Apps, Reminders, Files — order and visibility from "Customize
 * sidebar", `sidebar-nav-store.ts`; the Review row merged into the Repo
 * page's review section in KRTX-2444 and its count now badges Files).
 *
 * Footer: status and the two connect rows only (Jay, 2026-10-12): "keep the
 * bottom part as low as possible". The footer is bottom-anchored (`mt-auto`),
 * so every row that mounts late shoves everything above it up the page. Fewer
 * rows down here is less of that.
 *
 * `SidebarUpgradeButton` stays last (Jay, 2026-09-03): it is the only paid
 * call to action in the group, and it renders only on a free plan.
 *
 * Asserted against the source because the alternative is mounting the whole
 * sidebar (sidebar + auth + query + i18n providers) to observe pure ordering.
 */
const source = readFileSync(join(import.meta.dir, 'project-sidebar.tsx'), 'utf8');

function orderOf(component: string): number {
  const at = source.indexOf(`<${component}`);
  expect(at).toBeGreaterThan(-1);
  return at;
}

const footerStart = source.indexOf('<SidebarGroup className="mt-auto">');
const footer = source.slice(footerStart, source.indexOf('</SidebarGroup>', footerStart));

describe('project sidebar layout', () => {
  test('the nav rows render in the top group, above the session list', () => {
    expect(orderOf('ProjectNavItems')).toBeLessThan(orderOf('ProjectSessionList'));
  });

  test('the footer holds status and the two connect rows, nothing else', () => {
    expect(footer.match(/<(Project|Sidebar)\w+(?=[\s/>])/g)).toEqual([
      '<SidebarGroup',
      '<SidebarMenu',
      '<ProjectSandboxAlert',
      '<ProjectManifestUpgradeAlert',
      '<SidebarBalanceWarning',
      '<SidebarMenu',
      '<ProjectMcpNavItem',
      '<ProjectComputerNavItem',
      '<SidebarUpgradeButton',
    ]);
  });

  test('no nav row and no ChatGPT row is rendered directly by the sidebar', () => {
    for (const row of [
      'ProjectCustomizeNavItem',
      'ProjectAppsNavItem',
      'ProjectChangeRequestsNavItem',
      'ProjectRemindersNavItem',
      'ProjectFilesNavItem',
      'ProjectChatGptConnectNavItem',
      'ProjectSettingsNavItem',
      'ProjectConnectorsNavItem',
      'ProjectSkillsNavItem',
      'ProjectCommandsNavItem',
    ]) {
      expect(source).not.toContain(`<${row}`);
    }
  });

  test('the Customize sidebar modal is mounted outside <Sidebar>', () => {
    // The mobile sheet unmounts its content on close, which would close the
    // modal with it.
    expect(orderOf('CustomizeSidebarModal')).toBeGreaterThan(source.indexOf('</Sidebar>'));
  });

  test('a hidden row stays reachable: the More row lists every "Show in More" row', () => {
    // Hiding Review or Files must never strand the page (Jay, 2026-10-12).
    const nav = readFileSync(join(import.meta.dir, 'project-nav-items.tsx'), 'utf8');
    expect(nav.indexOf('<MoreNavItem')).toBeGreaterThan(nav.indexOf('<NavItem'));
    expect(nav).toContain("e.visibility === 'never'");
    expect(nav).toContain('openCustomizeSidebar');
  });
});
