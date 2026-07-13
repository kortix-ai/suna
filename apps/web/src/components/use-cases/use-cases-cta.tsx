import Link from 'next/link';
import { HiArrowRight } from 'react-icons/hi2';

import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import KortixGrid from '@/components/ui/marketing/gridder';

/**
 * Closing CTA for the use-cases surface. Mirrors the landing page `#cta`
 * treatment (KortixGrid field + card) so the section reads as one platform.
 */
export function UseCasesCta() {
  return (
    <section className="relative mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0">
      <Reveal>
        <div className="border-border bg-card relative overflow-hidden rounded-sm border">
          <div className="flex grid-cols-12 flex-col-reverse gap-2 md:grid">
            <div className="col-span-5 flex flex-col items-start justify-center space-y-4 p-8 sm:p-10">
              <Badge variant="kortix" className="rounded">
                Loop Engineering
              </Badge>
              <h2 className="text-foreground text-2xl leading-tight font-medium tracking-tight sm:text-3xl">
                Engineer your first loop
              </h2>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Give your company a workforce of agents that run on a schedule, ship real
                deliverables, and improve one reviewed change at a time. Free to self-host, managed
                cloud from $20.
              </p>
              <p className="text-muted-foreground text-xs tracking-wider">
                Open source · SSO · RBAC · on-prem · no lock-in
              </p>
              <div className="mt-2 grid w-full grid-cols-1 gap-2 sm:max-w-xs">
                <Button asChild size="lg" className="w-full">
                  <Link href="/auth">
                    Get started
                    <HiArrowRight className="size-4" />
                  </Link>
                </Button>
                <Button asChild size="lg" variant="accent" className="w-full">
                  <Link href="/enterprise">Talk to sales</Link>
                </Button>
              </div>
            </div>
            <div className="col-span-1 hidden md:block" />
            <div className="col-span-6 mask-y-from-90% mask-x-from-90%">
              <KortixGrid count={58} seed={4228} />
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
