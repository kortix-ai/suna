import { ArrowRight } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';

import { SHOWCASE_EFFECTS } from './effects';

export const metadata: Metadata = {
  title: 'Showcase — Kortix',
  description: 'Interactive brand effects built on the Kortix mark.',
  robots: { index: false, follow: false },
};

export default function ShowcasePage() {
  return (
    <main className="bg-background min-h-screen px-6 py-16 antialiased sm:py-24">
      {/* Scoped, reduced-motion-aware stagger so the list settles in on load. */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
            @media (prefers-reduced-motion: no-preference) {
              .showcase-enter { opacity: 0; transform: translateY(10px); animation: showcase-enter 0.5s cubic-bezier(0.23,1,0.32,1) forwards; }
              @keyframes showcase-enter { to { opacity: 1; transform: translateY(0); } }
            }
          `,
        }}
      />

      <div className="mx-auto flex max-w-3xl flex-col gap-10">
        <header className="showcase-enter flex flex-col gap-3">
          <h1 className="text-foreground text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Showcase
          </h1>
          <p className="text-muted-foreground text-base text-pretty">
            Interactive brand effects built on the Kortix mark. Pick one to play with it on its own
            page.
          </p>
        </header>

        <ul className="flex flex-col gap-3">
          {SHOWCASE_EFFECTS.map((effect, index) => (
            <li
              key={effect.slug}
              className="showcase-enter"
              style={{ animationDelay: `${(index + 1) * 60}ms` }}
            >
              <Link
                href={`/showcase/${effect.slug}`}
                className="group bg-card relative flex items-center gap-4 rounded-2xl px-5 py-4 ring-1 ring-black/10 transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-[0_1px_2px_rgba(0,0,0,0.06),0_12px_28px_-14px_rgba(0,0,0,0.35)] dark:ring-white/10"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <h2 className="text-foreground truncate text-base font-medium tracking-tight">
                      {effect.name}
                    </h2>
                    <Badge variant="outline" size="xs" className="text-muted-foreground shrink-0">
                      {effect.tech}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground text-sm text-pretty">{effect.tagline}</p>
                </div>
                <ArrowRight className="text-muted-foreground group-hover:text-foreground size-4 shrink-0 transition-transform duration-200 group-hover:translate-x-0.5" />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
