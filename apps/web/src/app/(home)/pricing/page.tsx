'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { useNewInstanceModalStore } from '@/stores/pricing-modal-store';
import { CreditsExplainedModal } from '@/components/billing/credits-explained-modal';
import { Button } from '@/components/ui/button';
import { ArrowRight, Check, GitFork } from 'lucide-react';

const FREE_FEATURES = [
  'BYOC (bring your own API key)',
  'Haiku model access',
  'Self-host on your own machine',
  'All open-source features',
];

const PRO_FEATURES = [
  'All models (Claude, GPT, Gemini, …)',
  'Managed cloud computer — your dedicated Linux sandbox',
  '60+ built-in skills, 3,000+ integrations',
  'Persistent memory across all agents',
  'Cron triggers + webhook triggers',
  'Slack, Telegram, and channel integrations',
  'Team access controls + project-scoped channels',
  'iOS and Android apps',
  'Priority support',
];

const COMPETITOR_TABLE = [
  { name: 'Kortix Pro',    price: '$20/mo', scope: 'General-purpose agent OS',   openSource: true,  selfHost: true  },
  { name: 'Cursor Pro',    price: '$20/mo', scope: 'IDE-native coding assistant', openSource: false, selfHost: false },
  { name: 'Devin Core',    price: '$20/mo', scope: 'Autonomous coding agent',     openSource: false, selfHost: false },
  { name: 'Manus',         price: '$39/mo', scope: 'General-purpose agent',       openSource: false, selfHost: false },
];

export default function PricingPage() {
  const [creditsModalOpen, setCreditsModalOpen] = useState(false);
  const openNewInstanceModal = useNewInstanceModalStore((s) => s.openNewInstanceModal);

  return (
    <main className="min-h-screen bg-background">
      <article className="max-w-3xl mx-auto px-6 md:px-10 pt-24 md:pt-28 pb-20">

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="space-y-3 mb-12"
        >
          <h1 className="text-4xl font-semibold tracking-tight">Pricing</h1>
          <p className="text-muted-foreground text-lg max-w-xl">
            Same price as Cursor Pro and Devin Core. Broader scope.
          </p>
        </motion.div>

        {/* Plan cards */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-14"
        >
          {/* Free */}
          <div className="rounded-2xl border border-border bg-card/40 p-6 flex flex-col gap-4">
            <div>
              <span className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Free</span>
              <div className="mt-1 flex items-end gap-1">
                <span className="text-4xl font-semibold tracking-tight">$0</span>
                <span className="text-muted-foreground text-sm mb-1.5">/mo</span>
              </div>
              <p className="text-sm text-muted-foreground mt-1">Self-host with your own API keys.</p>
            </div>
            <ul className="flex flex-col gap-2 flex-1">
              {FREE_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <Check className="size-3.5 mt-0.5 shrink-0 text-foreground/60" />
                  {f}
                </li>
              ))}
            </ul>
            <a
              href="https://github.com/kortix-ai/suna"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <GitFork className="size-3.5" />
              Open source on GitHub
            </a>
          </div>

          {/* Pro */}
          <div className="rounded-2xl border border-foreground/20 bg-foreground/[0.03] p-6 flex flex-col gap-4 relative">
            <div className="absolute top-4 right-4">
              <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-foreground text-background">
                Same price as Cursor Pro
              </span>
            </div>
            <div>
              <span className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Pro</span>
              <div className="mt-1 flex items-end gap-1">
                <span className="text-4xl font-semibold tracking-tight">$20</span>
                <span className="text-muted-foreground text-sm mb-1.5">/mo</span>
              </div>
              <p className="text-sm text-muted-foreground mt-1">Managed cloud computer. All models. Full scope.</p>
            </div>
            <ul className="flex flex-col gap-2 flex-1">
              {PRO_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm text-foreground/80">
                  <Check className="size-3.5 mt-0.5 shrink-0 text-foreground" />
                  {f}
                </li>
              ))}
            </ul>
            <Button size="default" className="w-full rounded-xl" onClick={() => openNewInstanceModal()}>
              Get Your Kortix <ArrowRight className="ml-1.5 size-3.5" />
            </Button>
          </div>
        </motion.div>

        {/* Competitor comparison */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="mb-14"
        >
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
            At $20/mo, here&apos;s what you&apos;re choosing between
          </h2>
          <div className="rounded-xl border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Product</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Price</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden sm:table-cell">Scope</th>
                  <th className="text-center px-4 py-3 font-medium text-muted-foreground">Open source</th>
                  <th className="text-center px-4 py-3 font-medium text-muted-foreground hidden sm:table-cell">Self-host</th>
                </tr>
              </thead>
              <tbody>
                {COMPETITOR_TABLE.map((row, i) => (
                  <tr
                    key={row.name}
                    className={`border-b border-border last:border-0 ${i === 0 ? 'bg-foreground/[0.03]' : ''}`}
                  >
                    <td className="px-4 py-3 font-medium text-foreground">{row.name}</td>
                    <td className="px-4 py-3 text-foreground">{row.price}</td>
                    <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">{row.scope}</td>
                    <td className="px-4 py-3 text-center">
                      {row.openSource
                        ? <Check className="size-4 text-foreground mx-auto" />
                        : <span className="text-muted-foreground/40">—</span>}
                    </td>
                    <td className="px-4 py-3 text-center hidden sm:table-cell">
                      {row.selfHost
                        ? <Check className="size-4 text-foreground mx-auto" />
                        : <span className="text-muted-foreground/40">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Prices as of April 2026. Cursor Pro $20/mo · Devin Core $20/mo · Manus $39/mo (Pro tier).
          </p>
        </motion.div>

        {/* Enterprise row */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.3 }}
          className="rounded-2xl border border-border bg-card/40 p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"
        >
          <div>
            <span className="text-sm font-semibold text-foreground">Enterprise</span>
            <p className="text-sm text-muted-foreground mt-1 max-w-md">
              Custom compute, dedicated infra, SSO, SLA, on-premise deployment. Talk to us.
            </p>
          </div>
          <a
            href="mailto:hi@kortix.com"
            className="shrink-0 inline-flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-muted-foreground transition-colors"
          >
            Contact us <ArrowRight className="size-3.5" />
          </a>
        </motion.div>

        <CreditsExplainedModal open={creditsModalOpen} onOpenChange={setCreditsModalOpen} />
      </article>
    </main>
  );
}
