'use client';

import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { Faq, PageCta } from '@/features/marketing/v2/page-kit';
import { Display, Lead, MAX_W } from '@/features/marketing/v2/primitives';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { cn } from '@/lib/utils';
import { Check } from 'lucide-react';
import { useCallback } from 'react';

const TIERS = [
  {
    name: 'Free',
    blurb: 'Start on your own machine. Self-host as long as you like.',
    price: '$0',
    unit: '/month',
    cta: 'Get started',
    features: [
      'Self-host, unlimited',
      '1 project on Kortix Cloud',
      'Up to 3 members',
      'Bring your own model keys',
      'Community support',
    ],
  },
  {
    name: 'Pro',
    blurb: 'For individuals and small teams running agents every day.',
    price: '$20',
    unit: '/month',
    cta: 'Subscribe',
    featured: true,
    features: [
      'Unlimited projects',
      'Up to 10 members',
      'Managed sandboxes included',
      'All connectors and channels',
      'Bring the model subscription you pay for',
      'Triggers and automations',
    ],
  },
  {
    name: 'Enterprise',
    blurb: 'For companies that need SSO, isolation, and an audit trail.',
    price: 'Custom',
    unit: '',
    cta: 'Talk to us',
    features: [
      'SSO and SCIM provisioning',
      'Members, groups, and roles',
      'VPC, on-prem, or air-gapped',
      'Audit export and approval gates',
      'Named contact and an SLA',
    ],
  },
];

export default function PricingPage() {
  const { user } = useAuth();
  const openDemo = useRequestDemo();

  const start = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  return (
    <main className="bg-background">
      <section className="pt-32 sm:pt-40">
        <div className={MAX_W}>
          <div className="mx-auto max-w-2xl text-center">
            <Display lines={['Simple, transparent', 'pricing.']} as="h1" className="sm:text-[3.5rem]" />
            <Lead className="mt-6">
              Free to self-host, forever. Pay when you want us to run the sandboxes, and only for
              what your team actually uses.
            </Lead>
          </div>

          <div className="mt-16 grid gap-4 lg:grid-cols-3">
            {TIERS.map((tier) => (
              <div
                key={tier.name}
                className={cn(
                  'flex flex-col rounded-[1.35rem] p-8',
                  tier.featured ? 'text-white' : 'border-border border',
                )}
                style={
                  tier.featured
                    ? {
                        background:
                          'linear-gradient(160deg, color-mix(in oklab, var(--kortix-blue) 88%, black) 0%, var(--kortix-blue) 100%)',
                      }
                    : undefined
                }
              >
                <p
                  className={cn(
                    'text-[1.375rem] font-medium',
                    tier.featured ? 'text-white' : 'text-foreground',
                  )}
                >
                  {tier.name}
                </p>
                <p
                  className={cn(
                    'mt-2 text-[0.9375rem] leading-[1.5]',
                    tier.featured ? 'text-white/75' : 'text-muted-foreground',
                  )}
                >
                  {tier.blurb}
                </p>

                <p className="mt-8 flex items-baseline gap-1.5">
                  <span
                    className={cn(
                      'text-[2.75rem] leading-none font-medium tracking-tight',
                      tier.featured ? 'text-white' : 'text-foreground',
                    )}
                  >
                    {tier.price}
                  </span>
                  <span
                    className={cn(
                      'text-[0.9375rem]',
                      tier.featured ? 'text-white/70' : 'text-muted-foreground',
                    )}
                  >
                    {tier.unit}
                  </span>
                </p>

                <button
                  type="button"
                  onClick={tier.name === 'Enterprise' ? () => openDemo() : start}
                  className={cn(
                    'mt-7 flex h-11 w-full cursor-pointer items-center justify-center rounded-full text-[0.9375rem] font-medium transition-colors',
                    tier.featured
                      ? 'bg-white text-neutral-900 hover:bg-white/90'
                      : 'bg-foreground/[0.06] text-foreground hover:bg-foreground/10',
                  )}
                >
                  {tier.cta}
                </button>

                <ul className="mt-8 space-y-3.5">
                  {tier.features.map((f) => (
                    <li key={f} className="flex items-start gap-2.5">
                      <span
                        className={cn(
                          'mt-[3px] flex size-[18px] shrink-0 items-center justify-center rounded-full',
                          tier.featured ? 'bg-white/20 text-white' : 'bg-kortix-blue text-white',
                        )}
                      >
                        <Check className="size-3" strokeWidth={3} />
                      </span>
                      <span
                        className={cn(
                          'text-[0.9375rem] leading-[1.45]',
                          tier.featured ? 'text-white/90' : 'text-foreground',
                        )}
                      >
                        {f}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      <Faq
        heading={['Questions we', 'get asked.']}
        items={[
          {
            name: 'What exactly is free?',
            description:
              'Self-hosting. Kortix is open source, so you can run the whole platform on your own infrastructure indefinitely, with no seat count and no feature gate.',
          },
          {
            name: 'What am I paying for on the paid plans?',
            description:
              'We run the sandboxes, the gateway, and the managed git for you, and we keep them patched. You are paying for infrastructure and operations, not for access to features.',
          },
          {
            name: 'Can I use my own model subscription?',
            description:
              'Yes. Bring your Anthropic, OpenAI, or Bedrock key and the sessions bill against it. If you would rather not, use the managed models included in your plan.',
          },
          {
            name: 'What happens if I stop paying?',
            description:
              'Your projects are git repositories. Clone them and keep going, self-hosted, with the same agents, skills, and history. Nothing is held hostage.',
          },
          {
            name: 'Do agents count as members?',
            description:
              'No. Members are people. Agents are principals with their own permissions, and you can run as many as your sandbox capacity allows.',
          },
        ]}
      />

      <PageCta
        heading={['Start free.', 'Move when it earns it.']}
        body="Self-host today, and switch to managed the day running sandboxes stops being interesting."
      />
    </main>
  );
}
