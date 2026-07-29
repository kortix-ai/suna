'use client';

import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { Icon } from '@/features/icon/icon';
import { CtaSection, HeroSection } from '@/features/marketing/v2/page-kit';
import { Display, Lead, MAX_W, SoftCard } from '@/features/marketing/v2/primitives';
import { ArrowUpRight, Building2, LifeBuoy, MessageSquare } from 'lucide-react';
import Link from 'next/link';

type Route = {
  name: string;
  description: string;
  icon: (props: { className?: string }) => React.ReactNode;
  href?: string;
  action?: 'demo';
};

const ROUTES: Route[] = [
  {
    name: 'Talk to sales',
    description: 'Deployment, security review, and pricing for your team size.',
    icon: Building2,
    action: 'demo' as const,
  },
  {
    name: 'Get support',
    description: 'Something is broken, or you are stuck on a session.',
    icon: LifeBuoy,
    href: '/support',
  },
  {
    name: 'Join the Discord',
    description: 'Ask the community and see what other teams are running.',
    icon: MessageSquare,
    href: 'https://discord.com/invite/RvFhXUdZ9H',
  },
  {
    name: 'Open an issue',
    description: 'Kortix is open source. File it in the repo and we will see it.',
    icon: Icon.Github,
    href: 'https://github.com/kortix-ai/suna/issues',
  },
];

function RouteBody({ route, onDemo }: { route: Route; onDemo: () => void }) {
  const Glyph = route.icon;
  const content = (
    <>
      <span className="bg-background border-border flex size-11 items-center justify-center rounded-[0.75rem] border">
        <Glyph className="size-5" />
      </span>
      <p className="text-foreground mt-5 flex items-center gap-1.5 text-[1.125rem] font-medium">
        {route.name}
        <ArrowUpRight className="text-muted-foreground size-4" />
      </p>
      <p className="text-muted-foreground mt-2 text-[0.9375rem] leading-[1.55]">
        {route.description}
      </p>
    </>
  );

  if (route.href) {
    return (
      <Link href={route.href} className="flex flex-col">
        {content}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onDemo} className="flex cursor-pointer flex-col text-left">
      {content}
    </button>
  );
}

export default function ContactPage() {
  const openDemo = useRequestDemo();

  return (
    <main className="bg-background">
      <HeroSection
        id="hero"
        heading="Talk to the people building it."
        body="There is no queue and no tiered gatekeeping. Pick the route that fits and you will reach someone who works on the product."
        visual="none"
      />

      <section id="routes" className="scroll-mt-24 py-20 sm:py-28">
        <div className={MAX_W}>
          <div className="mx-auto max-w-2xl text-center">
            <Display lines="Four ways in." />
            <Lead className="mt-6">Pick whichever matches what you need.</Lead>
          </div>

          <div className="mt-14 grid gap-4 sm:grid-cols-2">
            {ROUTES.map((route) => (
              <SoftCard key={route.name}>
                <RouteBody route={route} onDemo={openDemo} />
              </SoftCard>
            ))}
          </div>

          <p className="text-muted-foreground mt-12 text-center text-[0.9375rem]">
            Prefer email? Write to{' '}
            <a href="mailto:hey@kortix.com" className="text-kortix-blue hover:underline">
              hey@kortix.com
            </a>
            .
          </p>
        </div>
      </section>

      <CtaSection
        id="cta"
        heading="Or just start."
        body="Self-host it, or create a project on Kortix Cloud and open the first change request today."
      />
    </main>
  );
}
