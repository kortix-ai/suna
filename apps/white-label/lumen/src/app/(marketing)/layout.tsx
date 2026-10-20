import { BrandMark } from '@/components/brand-mark';
import { BRAND } from '@/config/brand';
import { Button } from '@kortix/ui/button';
import Link from 'next/link';

/** The public site: no login, no client data. */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
          <Link href="/" aria-label={`${BRAND.name} home`}>
            <BrandMark />
          </Link>
          <nav aria-label="Site" className="hidden items-center gap-5 text-sm text-muted-foreground sm:flex">
            <Link href="/#product" className="hover:text-foreground">
              Product
            </Link>
            <Link href="/pricing" className="hover:text-foreground">
              Pricing
            </Link>
            <Link href="/security" className="hover:text-foreground">
              Security
            </Link>
          </nav>
          <div className="flex-1" />
          <Link href="/sign-in" className="text-sm text-muted-foreground hover:text-foreground">
            Sign in
          </Link>
          <Button asChild size="sm">
            <Link href="/sign-up">Start free trial</Link>
          </Button>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:flex-row sm:items-start sm:justify-between sm:px-6">
          <div className="max-w-xs">
            <BrandMark />
            <p className="mt-3 text-sm text-muted-foreground">{BRAND.tagline} Built for small firms and in-house teams.</p>
          </div>
          <nav aria-label="Footer" className="grid grid-cols-2 gap-x-12 gap-y-2 text-sm text-muted-foreground">
            <Link href="/#product" className="hover:text-foreground">
              Product
            </Link>
            <Link href="/pricing" className="hover:text-foreground">
              Pricing
            </Link>
            <Link href="/security" className="hover:text-foreground">
              Security
            </Link>
            <Link href="/sign-in" className="hover:text-foreground">
              Sign in
            </Link>
          </nav>
        </div>
        <div className="mx-auto max-w-6xl px-4 pb-8 text-xs text-muted-foreground sm:px-6">
          © {new Date().getFullYear()} {BRAND.name}. A demonstration product. Lumen gives analysis for a lawyer to review, not legal advice.
        </div>
      </footer>
    </div>
  );
}
