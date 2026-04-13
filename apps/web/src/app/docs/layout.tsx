import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { RootProvider } from 'fumadocs-ui/provider';
import type { ReactNode } from 'react';
import Link from 'next/link';

function DocsLogo() {
  return (
    <Link href="/docs" className="flex items-center gap-2.5 no-underline">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/kortix-symbol.svg"
        alt="Kortix"
        className="dark:invert flex-shrink-0"
        style={{ width: 18, height: 18 }}
      />
      <span className="font-medium text-sm tracking-[-0.01em] text-fd-foreground/80">
        Docs
      </span>
    </Link>
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
            text: 'GitHub',
            url: 'https://github.com/kortix-ai/suna',
            external: true,
          },
        ]}
        sidebar={{
          defaultOpenLevel: 0,
        }}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
