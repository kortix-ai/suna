import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';

import {
  DocsCollapsedControls,
  DocsSearchButton,
  DocsSearchIconButton,
  DocsSidebarCollapseButton,
  DocsSidebarFooter,
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
      search={{
        options: {
          // Search runs IN THE BROWSER against an index fetched once, instead
          // of one server round-trip per keystroke — see `api/search/route.ts`
          // for why. `delayMs: 0` goes with it: the 100ms debounce exists to
          // spare the network, and there is no network left to spare, so the
          // results move with the cursor.
          //
          // `type` is marked deprecated upstream in favour of re-creating the
          // dialog around `staticClient`. Not worth it here: fumadocs' dialog
          // owns the highlight rendering, the tag list and the keyboard model,
          // and a local copy of all three would drift on the next release for
          // the sake of one option that still works.
          type: 'static',
          delayMs: 0,
        },
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
        sidebar={{
          defaultOpenLevel: 1,
          // Our own bottom row (docs-controls.tsx). `links` and `themeSwitch`
          // are deliberately left empty: fumadocs renders those two into a
          // hardcoded `border bg-fd-secondary/50 rounded-lg` pill, and with
          // both empty its own `empty:hidden` drops the container entirely.
          // Keyed because fumadocs renders this slot as a bare item in a
          // children ARRAY (`dist/layouts/docs/slots/sidebar.js`: `children:
          // [languageSelect, iconLinks, footer]`), and React's reconciler warns
          // on any unkeyed element it reconciles from an array. The element is
          // ours, so the key has to be too — there is no prop fumadocs exposes
          // to fix it from their side.
          footer: <DocsSidebarFooter key="docs-sidebar-footer" />,
          // Collapse is still driven through useSidebar() by our own buttons
          // (docs-controls.tsx); false only strips fumadocs' built-in chrome.
          collapsible: false,
          components: {
            Separator: DocsSidebarSeparator,
          },
        }}
        // The theme control moved into `sidebar.footer` above — it is the app's
        // own toggle either way (the app-level next-themes provider owns
        // persistence; RootProvider theme is disabled above), but rendered
        // through this slot it was locked inside fumadocs' bordered pill.
        themeSwitch={{ enabled: false }}
      >
        <DocsCollapsedControls />
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
