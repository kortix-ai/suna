import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dir;
const SIDEBAR = readFileSync(join(HERE, 'project-sidebar.tsx'), 'utf8');
const NAV_ITEMS = readFileSync(join(HERE, 'project-nav-items.tsx'), 'utf8');
const ANON_SHELL = readFileSync(join(HERE, '..', '..', 'home', 'anonymous-home-shell.tsx'), 'utf8');

describe('sidebar structure', () => {
  test('no standalone destination rows — Files lives in Customize', () => {
    expect(SIDEBAR).not.toContain('ProjectDestinations');
  });

  test('Customize sits BELOW the session list — configuration after work', () => {
    expect(SIDEBAR.indexOf('<ProjectNavItems')).toBeGreaterThan(
      SIDEBAR.indexOf('<ProjectSessionList'),
    );
  });

  test('Files and Settings no longer render as loose footer rows', () => {
    expect(SIDEBAR).not.toContain('<ProjectFilesNavItem');
    expect(SIDEBAR).not.toContain('<ProjectSettingsNavItem');
  });
});

describe('the Customize group', () => {
  test('is a plain section, styled like the session list header', () => {
    // A disclosure here just invited people to hide their own configuration
    // and then wonder where it went.
    expect(NAV_ITEMS).toContain('<SidebarSectionLabel>Customize</SidebarSectionLabel>');
    expect(NAV_ITEMS).not.toContain('Collapsible');
  });

  test('leads with Files and ends with Settings', () => {
    expect(NAV_ITEMS).toContain('filesHref');
    expect(NAV_ITEMS).toContain('settingsHref');
    // Files is rendered before the mapped items, Settings after them.
    expect(NAV_ITEMS.indexOf('showFiles ? (')).toBeLessThan(NAV_ITEMS.indexOf('items.map('));
    expect(NAV_ITEMS.indexOf('items.map(')).toBeLessThan(NAV_ITEMS.indexOf('showSettings ? ('));
  });
});

describe('both shells use the same nav', () => {
  test('the signed-out shell renders the shared Customize group', () => {
    expect(ANON_SHELL).toContain('<ProjectNavGroup');
  });

  test('the signed-out shell gates Files and Settings rather than linking', () => {
    expect(ANON_SHELL).toContain("onSelectFiles={() => gate('/')}");
    expect(ANON_SHELL).toContain("onSelectSettings={() => gate('/')}");
  });
});

describe('the collapse control', () => {
  const CHROME = readFileSync(join(HERE, 'sidebar-chrome.tsx'), 'utf8');
  const PEEK = readFileSync(join(HERE, 'sidebar-peek-toggle.tsx'), 'utf8');

  test('is not inside the sidebar panel', () => {
    expect(CHROME).not.toContain('SidebarTrigger');
  });

  test('renders whether the sidebar is open or closed', () => {
    // Hiding it while open left most pages with no way to collapse at all.
    expect(PEEK).not.toContain('if (!collapsed) return null');
  });

  test('still summons the hover flyout while collapsed', () => {
    expect(PEEK).toContain('peekEnter');
    expect(PEEK).toContain('peekLeave');
  });
});
