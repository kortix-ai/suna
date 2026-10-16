import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { SidebarProvider } from '@/components/ui/sidebar';
import messages from '../../../../../translations/en.json';
import {
  manifestNeedsUpgrade,
  type ManifestVersion,
} from '@/features/workspace/customize/migrate-to-v3';
import { ProjectManifestUpgradeAlertView } from './project-manifest-upgrade-alert';

// The view renders sidebar primitives (SidebarMenuItem/Button), so every case
// needs a SidebarProvider context around it — same shell the sidebar's own
// tests use. `defaultOpen` expands the disclosure so its body (only mounted
// while open) is present in the static markup.
function render(props: {
  visible: boolean;
  pending: boolean;
  onMigrate: () => void;
  defaultOpen?: boolean;
}) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      messages={{ sidebar: messages.sidebar }}
      timeZone="UTC"
      onError={() => {}}
    >
      <SidebarProvider defaultOpen>
        <ProjectManifestUpgradeAlertView {...props} />
      </SidebarProvider>
    </NextIntlClientProvider>,
  );
}

describe('ProjectManifestUpgradeAlertView — pre-v3 visibility', () => {
  test('a v1 and a v2 project need the upgrade; a v3 project and an unresolved read do not', () => {
    expect([1, 2, 3, null].map((version) => manifestNeedsUpgrade(version as ManifestVersion | null))).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  test('shows the collapsed "Upgrade to v3" trigger when visible', () => {
    const html = render({ visible: true, pending: false, onMigrate: () => {} });
    expect(html).toContain('Upgrade to v3');
  });

  test('renders nothing at all once the project is on v3 (or the viewer cannot act)', () => {
    const html = render({ visible: false, pending: false, onMigrate: () => {} });
    expect(html).not.toContain('Upgrade to v3');
    expect(html).not.toContain('sidebar-menu-item');
  });

  test('expanded body explains the upgrade to kortix.yaml version 3 and offers the action', () => {
    const html = render({ visible: true, pending: false, onMigrate: () => {}, defaultOpen: true });
    expect(html).toContain('Start upgrade');
    expect(html).toContain('kortix.yaml');
    expect(html).toContain('version 3');
    // The row promises nothing happens without review — the reassurance IS the
    // reason someone clicks a migration they did not ask for.
    expect(html).toContain('Nothing changes until you approve it');
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
    expect(html).toContain('Start upgrade');
    onMigrate();
    expect(calls).toBe(1);
  });
});
