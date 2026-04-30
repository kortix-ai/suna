'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { useNewInstanceModalStore } from '@/stores/pricing-modal-store';
import { CreditsExplainedModal } from '@/components/billing/credits-explained-modal';
import { Button } from '@/components/ui/button';
import { Check, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import Link from 'next/link';

// ─── Tier data ────────────────────────────────────────────────────────────────

const TIERS = [
  {
    key: 'free',
    name: 'Free',
    price: '$0',
    period: '/mo',
    tagline: 'Bring your own compute',
    highlight: false,
    ctaLabel: 'Start free',
    ctaHref: '/auth/signup',
    features: [
      'Haiku model (fast, lightweight)',
      'Connect your own sandbox',
      '60+ built-in skills',
      '3,000+ integrations',
      'No sandbox included',
    ],
  },
  {
    key: 'starter',
    name: 'Starter',
    price: '$0',
    period: '/mo',
    tagline: 'Managed sandbox, daily credits',
    highlight: true,
    badge: 'New',
    ctaLabel: 'Get started',
    ctaHref: '/auth/signup',
    features: [
      'Haiku + Sonnet model access',
      'Managed Linux sandbox included',
      '5 credits/day (~2–3 Sonnet runs)',
      '60+ built-in skills',
      '3,000+ integrations',
      'Upgrade to Pro when ready',
    ],
  },
  {
    key: 'pro',
    name: 'Pro',
    price: '$20',
    period: '/mo',
    tagline: 'Unlimited runs, full compute power',
    highlight: false,
    ctaLabel: 'Get Pro',
    ctaHref: null, // opens new instance modal
    features: [
      'All models (Sonnet, Haiku, and more)',
      'Managed Linux sandbox included',
      'Unlimited agent runs',
      'Parallel compute add-ons',
      '60+ built-in skills',
      '3,000+ integrations',
      'Priority support',
    ],
  },
] as const;

// ─── Component ────────────────────────────────────────────────────────────────

export default function PricingPage() {
  const [creditsModalOpen, setCreditsModalOpen] = useState(false);
  const openNewInstanceModal = useNewInstanceModalStore((s) => s.openNewInstanceModal);

  return (
    <main className="min-h-screen bg-background">
      <article className="max-w-5xl mx-auto px-6 md:px-10 pt-24 md:pt-28 pb-20">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="text-center space-y-4 mb-14"
        >
          <h1 className="text-4xl font-semibold tracking-tight">Simple pricing</h1>
          <p className="text-muted-foreground text-lg max-w-xl mx-auto">
            One machine, one subscription. Priced by the specs you need.
          </p>
        </motion.div>

        {/* Tier cards */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="grid grid-cols-1 md:grid-cols-3 gap-6"
        >
          {TIERS.map((tier) => (
            <div
              key={tier.key}
              className={cn(
                'relative rounded-2xl border p-6 flex flex-col',
                tier.highlight
                  ? 'border-primary/60 bg-primary/[0.03] shadow-md'
                  : 'border-border bg-card',
              )}
            >
              {/* Badge */}
              {tier.badge && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground text-xs font-medium px-3 py-1 rounded-full">
                  {tier.badge}
                </span>
              )}

              {/* Header */}
              <div className="mb-6">
                <p className="text-sm font-medium text-muted-foreground mb-1">{tier.name}</p>
                <div className="flex items-end gap-1 mb-2">
                  <span className="text-4xl font-bold tracking-tight">{tier.price}</span>
                  <span className="text-muted-foreground mb-1">{tier.period}</span>
                </div>
                <p className="text-sm text-muted-foreground">{tier.tagline}</p>
              </div>

              {/* CTA */}
              <div className="mb-6">
                {tier.ctaHref ? (
                  <Button
                    asChild
                    variant={tier.highlight ? 'default' : 'outline'}
                    className="w-full"
                  >
                    <Link href={tier.ctaHref}>
                      {tier.ctaLabel} <ArrowRight className="ml-2 size-4" />
                    </Link>
                  </Button>
                ) : (
                  <Button
                    variant={tier.highlight ? 'default' : 'outline'}
                    className="w-full"
                    onClick={() => openNewInstanceModal()}
                  >
                    {tier.ctaLabel} <ArrowRight className="ml-2 size-4" />
                  </Button>
                )}
              </div>

              {/* Features */}
              <ul className="space-y-2.5 flex-1">
                {tier.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm">
                    <Check className="size-4 text-primary mt-0.5 flex-shrink-0" />
                    <span className="text-muted-foreground">{feature}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </motion.div>

        {/* Credits explainer link */}
        <p className="text-center text-sm text-muted-foreground mt-10">
          <button
            onClick={() => setCreditsModalOpen(true)}
            className="underline underline-offset-2 hover:text-foreground transition-colors"
          >
            How do credits work?
          </button>
          {' · '}
          All plans include 3,000+ integrations via Pipedream.
        </p>

        <CreditsExplainedModal open={creditsModalOpen} onOpenChange={setCreditsModalOpen} />
      </article>
    </main>
  );
}
