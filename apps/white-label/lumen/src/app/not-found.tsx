'use client';

import { Notice } from '@/components/access';
import { BrandMark } from '@/components/brand-mark';
import { FileMagnifyingGlassIcon } from '@phosphor-icons/react';
import Link from 'next/link';

// Every unknown URL, inside /app or not: Lumen's own page, in the active theme.
export default function NotFound() {
  return (
    <main className="min-h-dvh bg-background text-foreground">
      <header className="px-4 py-4 sm:px-6">
        <Link href="/" aria-label="Lumen home">
          <BrandMark />
        </Link>
      </header>
      <Notice icon={FileMagnifyingGlassIcon} title="Page not found" body="The link may be old or mistyped." href="/app" cta="Back to Lumen" />
    </main>
  );
}
