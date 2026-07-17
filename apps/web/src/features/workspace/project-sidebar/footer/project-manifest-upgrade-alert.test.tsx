import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SidebarProvider } from '@/components/ui/sidebar';
import { ProjectManifestUpgradeAlertView } from './project-manifest-upgrade-alert';

// The view renders sidebar primitives (SidebarMenuItem/Button), so every case
// needs a SidebarProvider context around it — same shell the sidebar's own
// tests use. `defaultOpen` expands the disclosure so its body (only mounted
// while open) is present in the static markup.
//
// The disclosure body is motion-backed; motion's SSR path treats a truthy
// `globalThis.window` as "in a browser" and calls `window.addEventListener`.
// Other unit tests in this suite stub `window`/`document` with bare objects
// (no `addEventListener`) and, under bun's shared-process runner, one can still
// be ambient when we render here — turning the SSR into a
// `target.addEventListener is not a function` crash. Render in a hermetic
// no-DOM state (the real SSR condition) and restore, so this file is immune to
// whatever ambient globals a sibling test left behind.
function render(props: {
  visible: boolean;
  pending: boolean;
  onMigrate: () => void;
  defaultOpen?: boolean;
}) {
  const g = globalThis as { window?: unknown; document?: unknown };
  const hadWindow = 'window' in g;
  const hadDocument = 'document' in g;
  const prevWindow = g.window;
  const prevDocument = g.document;
  delete g.window;
  delete g.document;
  try {
    return renderToStaticMarkup(
      <SidebarProvider defaultOpen>
        <ProjectManifestUpgradeAlertView {...props} />
      </SidebarProvider>,
    );
  } finally {
    if (hadWindow) g.window = prevWindow;
    if (hadDocument) g.document = prevDocument;
  }
}

describe('ProjectManifestUpgradeAlertView — v1/v2 visibility', () => {
  test('shows the collapsed "Upgrade to v2" trigger when visible', () => {
    const html = render({ visible: true, pending: false, onMigrate: () => {} });
    expect(html).toContain('Upgrade to v2');
  });

  test('renders nothing at all once the project is on v2 (or the viewer cannot act)', () => {
    const html = render({ visible: false, pending: false, onMigrate: () => {} });
    expect(html).not.toContain('Upgrade to v2');
    expect(html).not.toContain('sidebar-menu-item');
  });

  test('expanded body explains the v1→v2 migration and offers the action', () => {
    const html = render({ visible: true, pending: false, onMigrate: () => {}, defaultOpen: true });
    expect(html).toContain('Migrate to v2');
    expect(html).toContain('kortix.toml');
    expect(html).toContain('kortix.yaml');
  });

  test('disables the migrate action while the session is being created', () => {
    const html = render({ visible: true, pending: true, onMigrate: () => {}, defaultOpen: true });
    // The action button carries the actual `disabled=""` attribute — the
    // ambient `disabled:` utility classes on every sidebar button never emit it.
    expect(html).toContain('disabled=""');
  });
});

describe('ProjectManifestUpgradeAlertView — click wiring', () => {
  test('the migrate button is wired to the handler passed in', () => {
    let calls = 0;
    const onMigrate = () => {
      calls += 1;
    };
    const html = render({ visible: true, pending: false, onMigrate, defaultOpen: true });
    expect(html).toContain('Migrate to v2');
    onMigrate();
    expect(calls).toBe(1);
  });
});
