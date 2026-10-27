import { BRAND } from '@/config/brand';
import { WORDMARK } from '@/config/wordmark';
import Link from 'next/link';
import { FOOTER } from './content';
import { Container } from './parts';

/** Five link columns with grey labels, then the giant cropped wordmark. */
export function SiteFooter() {
  return (
    <footer className="overflow-hidden border-t border-hairline">
      <Container className="pt-20 pb-10">
        <nav aria-label="Footer" className="grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-3 lg:grid-cols-5">
          {FOOTER.map((col) => (
            <div key={col.label}>
              <p className="mb-4 text-[15px] text-muted-foreground">{col.label}</p>
              <ul className="space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.href}>
                    <Link href={l.href} className="text-[15px] tracking-[-0.01em] transition-colors hover:text-muted-foreground">
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="mt-16 flex flex-col gap-2 text-[13px] text-muted-foreground sm:flex-row sm:justify-between">
          <p>
            © {new Date().getFullYear()} {BRAND.name}. Lumen gives analysis for a lawyer to review, not legal advice.
          </p>
          <p>Lumen is a reference product. Firms, people and stories on this site are fictional.</p>
        </div>
      </Container>
      {/* The giant wordmark at the content width, cropped by the page edge. */}
      <Container>
        <div aria-hidden className="h-[13vw] max-h-[190px] overflow-hidden">
          <svg viewBox={`0 0 ${WORDMARK.width} ${WORDMARK.height}`} className="block w-full fill-paper-deep">
            <path d={WORDMARK.d} />
          </svg>
        </div>
      </Container>
    </footer>
  );
}
