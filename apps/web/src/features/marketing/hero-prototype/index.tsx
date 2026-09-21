'use client';

import { Button } from '@/components/ui/button';
import Hero from '@/features/marketing/hero';
import { ArrowLeftIcon, ArrowRightIcon, XIcon } from '@phosphor-icons/react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import HeroA from './hero-a';

/** Development-only comparison on the real home route. No product state persists. */
export default function HeroPrototype() {
  const [showComparison, setShowComparison] = useState(true);
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const selected = params.get('variant');
  if (selected !== 'hero-a' && selected !== 'current') return <Hero />;
  const change = () => {
    const next = new URLSearchParams(params.toString());
    next.set('variant', selected === 'hero-a' ? 'current' : 'hero-a');
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };
  return (
    <>
      {selected === 'hero-a' ? <HeroA /> : <Hero />}
      {showComparison && params.get('compare') === '1' && (
        <aside
          aria-label="Hero prototype comparison"
          className="bg-popover fixed bottom-4 left-1/2 z-40 flex max-w-full -translate-x-1/2 items-center gap-2 rounded-full border px-2 py-1 shadow-md"
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              change();
            }
          }}
        >
          <Button
            variant="ghost"
            className="size-12 rounded-full"
            onClick={change}
            aria-label="Previous hero variant"
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
          <span className="min-w-32 text-center text-xs">
            <span className="text-muted-foreground">Prototype / </span>
            <strong className="font-medium">{selected === 'hero-a' ? 'Hero A' : 'Current'}</strong>
          </span>
          <Button
            variant="ghost"
            className="size-12 rounded-full"
            onClick={change}
            aria-label="Next hero variant"
          >
            <ArrowRightIcon className="size-4" />
          </Button>
          <Button
            variant="ghost"
            className="size-12 rounded-full"
            aria-label="Hide comparison bar"
            onClick={() => setShowComparison(false)}
          >
            <XIcon className="size-3.5" />
          </Button>
        </aside>
      )}
    </>
  );
}
