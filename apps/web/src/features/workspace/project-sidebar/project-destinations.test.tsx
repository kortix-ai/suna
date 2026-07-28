import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { Sidebar, SidebarProvider } from '@/components/ui/sidebar';

import { PROJECT_DESTINATIONS, ProjectDestinationsGroup } from './project-destinations';

/** SidebarMenuButton reads useSidebar, so the group needs its provider. */
function render(node: React.ReactElement) {
  return renderToStaticMarkup(
    <SidebarProvider>
      <Sidebar>{node}</Sidebar>
    </SidebarProvider>,
  );
}

const HERE = import.meta.dir;
const SIDEBAR = readFileSync(join(HERE, 'project-sidebar.tsx'), 'utf8');
const NAV_ITEMS = readFileSync(join(HERE, 'project-nav-items.tsx'), 'utf8');
const ANON_SHELL = readFileSync(join(HERE, '..', '..', 'home', 'anonymous-home-shell.tsx'), 'utf8');

describe('destinations', () => {
  test('are Files, All sessions and Projects, in that order', () => {
    expect(PROJECT_DESTINATIONS.map((d) => d.label)).toEqual(['Files', 'All sessions', 'Projects']);
  });

  test('render as links when the surface has routes', () => {
    const html = render(
      <ProjectDestinationsGroup hrefFor={(k) => (k === 'projects' ? '/projects' : `/p/${k}`)} />,
    );
    expect(html).toContain('href="/projects"');
    expect(html).toContain('Files');
    expect(html).toContain('All sessions');
  });

  test('render as buttons when there is nowhere to go yet', () => {
    // The signed-out shell gates instead of navigating, so it passes no hrefFor.
    const html = render(<ProjectDestinationsGroup onSelect={() => {}} />);
    expect(html).not.toContain('<a ');
    expect(html).toContain('Files');
  });

  test('Projects points at the account-level list, not inside a project', () => {
    const html = render(
      <ProjectDestinationsGroup hrefFor={(k) => (k === 'projects' ? '/projects' : `/p/${k}`)} />,
    );
    expect(html).toContain('href="/projects"');
    expect(html).not.toContain('/p/projects');
  });
});

describe('sidebar structure', () => {
  test('destinations sit above the session list', () => {
    expect(SIDEBAR.indexOf('<ProjectDestinations')).toBeLessThan(
      SIDEBAR.indexOf('<ProjectSessionList'),
    );
  });

  test('Customize sits above the session list too, not stranded in the footer', () => {
    expect(SIDEBAR.indexOf('<ProjectNavItems')).toBeLessThan(
      SIDEBAR.indexOf('<ProjectSessionList'),
    );
  });

  test('Files and Settings no longer render as loose footer rows', () => {
    expect(SIDEBAR).not.toContain('<ProjectFilesNavItem');
    expect(SIDEBAR).not.toContain('<ProjectSettingsNavItem');
  });
});

describe('the Customize group', () => {
  test('collapses, and remembers whether it was open', () => {
    expect(NAV_ITEMS).toContain('Collapsible');
    expect(NAV_ITEMS).toContain('kortix.sidebar.customizeOpen');
  });

  test('starts expanded', () => {
    expect(NAV_ITEMS).toContain('useState(true)');
  });

  test('survives storage being unavailable', () => {
    // Private mode throws on localStorage access; a sidebar must not die for it.
    expect(NAV_ITEMS).toContain('catch');
  });

  test('carries Settings inside it', () => {
    expect(NAV_ITEMS).toContain('settingsHref');
    expect(NAV_ITEMS).toContain('>\n                Settings\n              </SidebarPlainLink>');
  });
});

describe('both shells use the same nav', () => {
  test('the signed-out shell renders the shared destinations and Customize group', () => {
    expect(ANON_SHELL).toContain('<ProjectDestinationsGroup');
    expect(ANON_SHELL).toContain('<ProjectNavGroup');
  });

  test('the signed-out shell gates them rather than linking into a project', () => {
    expect(ANON_SHELL).toContain("onSelect={() => gate('/')}");
    expect(ANON_SHELL).toContain("onSelectSettings={() => gate('/')}");
  });
});
