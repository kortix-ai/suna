'use client';

import { ThemeToggle } from '@/components/home/theme-toggle';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { FOOTER } from '@/features/marketing/v2/content';
import Link from 'next/link';

/** The inverted footer: foreground surface, background type, one accent tile. */
export function MarketingFooter() {
  return (
    <footer id="site-footer" className="bg-foreground text-background relative">
      <div className="mx-auto w-full max-w-[68rem] px-6 pt-20 pb-14 sm:pt-24">
        <div className="grid grid-cols-2 gap-x-8 gap-y-12 sm:grid-cols-3 lg:grid-cols-5">
          {FOOTER.map((column) => (
            <div key={column.title}>
              <h3 className="text-background text-[0.9375rem] font-medium">{column.title}</h3>
              <ul className="mt-6 space-y-4">
                {column.links.map((link) => (
                  <li key={link.name}>
                    <Link
                      href={link.href}
                      className="text-background/55 hover:text-background text-[0.9375rem] transition-colors"
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

        <div className="border-background/15 mt-20 flex flex-col gap-5 border-t pt-8 sm:flex-row sm:items-center sm:justify-between">
          <small className="text-background/45 text-xs">
            © {new Date().getFullYear()} Kortix. Open source, and yours to run.
          </small>
          <div className="flex items-center gap-6">
            {[
              { name: 'Privacy', href: '/legal?tab=privacy' },
              { name: 'Terms', href: '/legal?tab=terms' },
              { name: 'Status', href: 'https://status.kortix.com' },
            ].map((l) => (
              <Link
                key={l.name}
                href={l.href}
                className="text-background/45 hover:text-background text-xs"
              >
                {l.name}
              </Link>
            ))}
            {/* the toggle is token-driven, so give it a background-coloured surface to read against */}
            <div className="bg-background/90 [&_button]:text-foreground rounded-sm [&>div]:bg-transparent">
              <ThemeToggle variant="compact" />
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
