import { ThemeToggle } from '@/components/home/theme-toggle';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
// Server components import icons from '@/lib/icons/ssr': phosphor's
// context-free SSR entry defaults to weight "regular" and silently ignores
// DEFAULT_ICON_WEIGHT (see ssr.tsx's docblock). The client-only brand marks
// under '@/features/icon/icons/*' stay inside 'use client' surfaces like
// docs-page-actions.tsx, which picks its own GitHub mark for its actions.
import { GithubLogoIcon, SparkleIcon } from '@/lib/icons/ssr';
import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { RootProvider } from 'fumadocs-ui/provider/next';
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
    <span className="ml-1 flex items-center gap-2.5 no-underline">
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
            type: 'icon',
            text: 'Get started',
            label: 'Get started',
            icon: <SparkleIcon />,
            url: '/auth',
            external: false,
          },
          {
            type: 'icon',
            text: 'GitHub',
            label: 'GitHub',
            icon: <GithubLogoIcon />,
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
