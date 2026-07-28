'use client';

import { ThemeToggle } from '@/components/home/theme-toggle';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { FOOTER } from '@/features/marketing/v2/content';
import Link from 'next/link';

export function MarketingFooter() {
  return (
    <footer id="site-footer" className="bg-card border-border relative border-t px-6 pt-16 pb-12">
      <div className="mx-auto max-w-6xl">
        <div className="grid grid-cols-2 gap-x-8 gap-y-10 sm:grid-cols-3 lg:grid-cols-5">
          {FOOTER.map((column) => (
            <div key={column.title}>
              <h3 className="text-muted-foreground pb-2 text-sm">{column.title}</h3>
              <ul>
                {column.links.map((link) => (
                  <li key={link.name}>
                    <Link
                      href={link.href}
                      className="text-foreground hover:text-foreground/70 inline-block py-1 text-sm transition-colors"
                    >
                      {link.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="border-border mt-16 flex flex-col items-start justify-between gap-6 border-t pt-8 md:flex-row md:items-center">
          <div className="text-muted-foreground flex items-center gap-3">
            <KortixLogo size={16} variant="logomark" />
            <small className="text-sm">
              © {new Date().getFullYear()} Kortix. Open source, and yours to run.
            </small>
          </div>

          <div className="flex items-center gap-6">
            <Link
              href="/legal?tab=privacy"
              className="text-muted-foreground hover:text-foreground text-sm transition-colors"
            >
              Privacy
            </Link>
            <Link
              href="/legal?tab=terms"
              className="text-muted-foreground hover:text-foreground text-sm transition-colors"
            >
              Terms
            </Link>
            <Link
              href="https://status.kortix.com"
              className="text-muted-foreground hover:text-foreground text-sm transition-colors"
            >
              Status
            </Link>
            <ThemeToggle variant="compact" />
          </div>
        </div>
      </div>
    </footer>
  );
}
