'use client';

import { ThemeToggle } from '@/components/home/theme-toggle';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { FOOTER } from '@/features/marketing/v2/content';
import Link from 'next/link';

/** Black footer with the big gradient brand tile, like Tembo's. */
export function MarketingFooter() {
  return (
    <footer id="site-footer" className="relative bg-black text-white">
      <div className="mx-auto w-full max-w-[68rem] px-6 pt-20 pb-14 sm:pt-24">
        <div className="grid grid-cols-2 gap-x-8 gap-y-12 sm:grid-cols-3 lg:grid-cols-5">
          {FOOTER.map((column) => (
            <div key={column.title}>
              <h3 className="text-[0.9375rem] font-medium text-white">{column.title}</h3>
              <ul className="mt-6 space-y-4">
                {column.links.map((link) => (
                  <li key={link.name}>
                    <Link
                      href={link.href}
                      className="text-[0.9375rem] text-white/50 transition-colors hover:text-white"
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
            className="flex size-44 items-center justify-center rounded-[1.5rem]"
            style={{
              background:
                'linear-gradient(180deg, color-mix(in oklab, var(--kortix-blue) 88%, black) 0%, var(--kortix-blue) 45%, color-mix(in oklab, var(--kortix-blue) 30%, white) 100%)',
            }}
          >
            <KortixLogo size={56} variant="symbol" className="text-white" />
          </div>
        </div>

        <div className="mt-20 flex flex-col gap-5 border-t border-white/10 pt-8 sm:flex-row sm:items-center sm:justify-between">
          <small className="text-xs text-white/40">
            © {new Date().getFullYear()} Kortix. Open source, and yours to run.
          </small>
          <div className="flex items-center gap-6">
            {[
              { name: 'Privacy', href: '/legal?tab=privacy' },
              { name: 'Terms', href: '/legal?tab=terms' },
              { name: 'Status', href: 'https://status.kortix.com' },
            ].map((l) => (
              <Link key={l.name} href={l.href} className="text-xs text-white/40 hover:text-white">
                {l.name}
              </Link>
            ))}
            {/* the toggle is token-driven, so give it a light surface to read against */}
            <div className="rounded-sm bg-white/90 [&_button]:text-neutral-900 [&>div]:bg-transparent">
              <ThemeToggle variant="compact" />
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
