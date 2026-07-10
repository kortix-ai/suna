import { ThemeToggle } from '@/components/home/theme-toggle';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Icon } from '@/features/icon/icon';
import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { RootProvider } from 'fumadocs-ui/provider';
import type { ReactNode } from 'react';

import {
  DocsCollapsedControls,
  DocsSearchButton,
  DocsSearchIconButton,
  DocsSidebarCollapseButton,
  DocsSidebarSeparator,
} from './docs-controls';

// Fumadocs wraps `nav.title` in a link to `nav.url` ("/docs"), so this must NOT
// contain its own anchor — a nested <a> breaks hydration.
function DocsLogo() {
  return (
    <span className="flex items-center gap-2.5 no-underline ml-1">
      {/* The canonical full Kortix logo (symbol + wordmark), via the shared
          KortixLogo component so the docs stay in lockstep with the rest of
          the app's brand treatment. */}
      <KortixLogo variant="logomark" size={18} />
    </span>
  );
}

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <RootProvider
      theme={{
        enabled: false,
      }}
    >
      <DocsLayout
        tree={source.getPageTree()}
        nav={{
          title: <DocsLogo />,
          url: '/docs',
          // Our own collapse trigger — `sidebar.collapsible: false` below
          // removes fumadocs' stock trigger + floating CollapsibleControl.
          children: <DocsSidebarCollapseButton />,
        }}
        searchToggle={{
          components: {
            lg: <DocsSearchButton />,
            sm: <DocsSearchIconButton />,
          },
        }}
        links={[
          {
            text: 'Home',
            url: '/',
          },
          {
            text: 'Changelog',
            url: '/changelog',
          },
          {
            type: 'icon',
            text: 'GitHub',
            label: 'GitHub',
            icon: <Icon.Github />,
            url: 'https://github.com/kortix-ai/suna',
            external: true,
          },
        ]}
        sidebar={{
          defaultOpenLevel: 1,
          // Collapse is still driven through useSidebar() by our own buttons
          // (docs-controls.tsx); false only strips fumadocs' built-in chrome.
          collapsible: false,
          components: {
            Separator: DocsSidebarSeparator,
          },
        }}
        themeSwitch={{
          // The app's own theme control (same one as the user menu) instead of
          // the fumadocs switch. The app-level next-themes provider still owns
          // persistence; RootProvider theme is disabled above.
          component: (
            <div className="ms-auto">
              <ThemeToggle variant="compact" />
            </div>
          ),
        }}
      >
        <DocsCollapsedControls />
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
