'use client';

import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { CenterHero } from '@/features/marketing/v2/page-kit';
import { MAX_W, Pill } from '@/features/marketing/v2/primitives';
import { Icon } from '@/features/icon/icon';
import { ArrowUpRight, Building2, LifeBuoy, MessageSquare } from 'lucide-react';
import Link from 'next/link';

const ROUTES = [
  {
    name: 'Talk to sales',
    description: 'Deployment, security review, pricing for your team size.',
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
    href: 'https://github.com/kortix-ai/suna',
  },
];

export default function ContactPage() {
  const openDemo = useRequestDemo();

  return (
    <main className="bg-background">
      <CenterHero
        heading={['Talk to the', 'people building it.']}
        body="There is no queue and no tiered gatekeeping. Pick the route that fits and you will reach someone who works on the product."
        cta={false}
      />

      <section className="py-16 sm:py-24">
        <div className={MAX_W}>
          <div className="grid gap-4 sm:grid-cols-2">
            {ROUTES.map((route) => {
              const inner = (
                <>
                  <span className="bg-background border-border flex size-11 items-center justify-center rounded-[0.75rem] border">
                    <route.icon className="size-5" />
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

              const className =
                'flex cursor-pointer flex-col rounded-[1.35rem] p-7 text-left transition-shadow hover:shadow-[0_18px_50px_-18px_rgba(26,31,46,0.22)]';
              const style = {
                background:
                  'linear-gradient(155deg, color-mix(in oklab, var(--kortix-blue) 3%, var(--background)) 0%, color-mix(in oklab, var(--kortix-blue) 11%, var(--background)) 100%)',
                border: '1px solid color-mix(in oklab, var(--kortix-blue) 11%, transparent)',
              };

              return route.action === 'demo' ? (
                <button
                  key={route.name}
                  type="button"
                  onClick={() => openDemo()}
                  className={className}
                  style={style}
                >
                  {inner}
                </button>
              ) : (
                <Link key={route.name} href={route.href!} className={className} style={style}>
                  {inner}
                </Link>
              );
            })}
          </div>

          <div className="mt-12 text-center">
            <p className="text-muted-foreground text-[0.9375rem]">
              Prefer email? Write to{' '}
              <a href="mailto:hey@kortix.com" className="text-kortix-blue hover:underline">
                hey@kortix.com
              </a>
              .
            </p>
            <Pill className="mt-6" onClick={() => openDemo()}>
              Request a demo
            </Pill>
          </div>
        </div>
      </section>
    </main>
  );
}
