import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { RootProvider } from 'fumadocs-ui/provider';
import { Github } from 'lucide-react';
import type { ReactNode } from 'react';

// Fumadocs wraps `nav.title` in a link to `nav.url` ("/docs"), so this must NOT
// contain its own anchor — a nested <a> breaks hydration.
function DocsLogo() {
  return (
    <span className="flex items-center gap-2.5 no-underline">
      {/* The canonical full Kortix logo (symbol + wordmark), via the shared
          KortixLogo component so the docs stay in lockstep with the rest of
          the app's brand treatment. */}
      <KortixLogo variant="logomark" size={18} />
      <span aria-hidden className="bg-fd-border h-3.5 w-px shrink-0" />
      <span className="text-fd-muted-foreground text-[13px] font-medium tracking-tight">Docs</span>
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
            icon: <Github />,
            url: 'https://github.com/kortix-ai/suna',
            external: true,
          },
        ]}
        sidebar={{
          defaultOpenLevel: 1,
          collapsible: true,
        }}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
