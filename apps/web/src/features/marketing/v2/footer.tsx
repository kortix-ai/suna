'use client';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { FOOTER } from '@/features/marketing/v2/content';
import Link from 'next/link';

export function MarketingFooter() {
  return (
    <footer className="bg-neutral-950 text-white">
      <div className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
        <div className="grid grid-cols-2 gap-x-8 gap-y-12 sm:grid-cols-3 lg:grid-cols-5">
          {FOOTER.map((column) => (
            <div key={column.title}>
              <h3 className="text-sm font-medium text-white">{column.title}</h3>
              <ul className="mt-6 space-y-4">
                {column.links.map((link) => (
                  <li key={link.name}>
                    <Link
                      href={link.href}
                      className="text-sm text-white/55 transition-colors hover:text-white"
                    >
                      {link.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-24 flex justify-center">
          <div
            className="flex size-40 items-center justify-center rounded-2xl"
            style={{
              background:
                'linear-gradient(180deg, color-mix(in oklab, var(--kortix-blue) 85%, #0d2a4d) 0%, color-mix(in oklab, var(--kortix-blue) 25%, white) 100%)',
            }}
          >
            <KortixLogo size={52} variant="symbol" className="text-white" />
          </div>
        </div>

        <div className="mt-16 flex flex-col gap-4 border-t border-white/[0.08] pt-8 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-white/40">
            © {new Date().getFullYear()} Kortix. Open source, and yours to run.
          </p>
          <div className="flex gap-6">
            <Link href="/legal?tab=privacy" className="text-xs text-white/40 hover:text-white">
              Privacy
            </Link>
            <Link href="/legal?tab=terms" className="text-xs text-white/40 hover:text-white">
              Terms
            </Link>
            <Link href="https://status.kortix.com" className="text-xs text-white/40 hover:text-white">
              Status
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
