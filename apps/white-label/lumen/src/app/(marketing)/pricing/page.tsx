import { api } from '@convex/_generated/api';
import { cn } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import { CheckIcon } from '@phosphor-icons/react/dist/ssr';
import { fetchAction } from 'convex/nextjs';
import type { FunctionReturnType } from 'convex/server';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Pricing · Lumen' };
// Prices come from Stripe at request time; the source holds none.
export const dynamic = 'force-dynamic';

type Prices = FunctionReturnType<typeof api.billing.prices>;

async function loadPrices(): Promise<Prices> {
  try {
    return await fetchAction(api.billing.prices, {}, { url: process.env.NEXT_PUBLIC_CONVEX_URL });
  } catch {
    return { mode: 'off', plans: {} };
  }
}

const PLANS = [
  { id: 'solo', name: 'Solo', seats: '1 seat', blurb: 'For the independent practitioner.', cta: 'Start free trial', href: '/sign-up' },
  { id: 'team', name: 'Team', seats: '2–25 seats', blurb: 'For a small firm or an in-house team.', cta: 'Start free trial', href: '/sign-up', featured: true },
  { id: 'firm', name: 'Firm', seats: '26+ seats', blurb: 'For larger practices with several teams.', cta: 'Talk to us', href: 'mailto:sales@lumen.example' },
] as const;

// Plans differ by seats only: every plan includes every feature.
const FEATURES = [
  'Assistant with cited answers',
  'Vault for PDF, Word and text documents',
  'Tabular review',
  'Workflows: playbook review, diligence, drafting',
  'Firm playbooks and templates',
  'Restricted matters',
  'Roles: owner, admin, lawyer',
  'Audit log with CSV export',
  'Usage by member and matter',
];

function money(p: { amount: number; currency: string; interval: string }) {
  const amount = new Intl.NumberFormat('en', { style: 'currency', currency: p.currency.toUpperCase(), maximumFractionDigits: 0 }).format(p.amount / 100);
  return { amount, per: `per seat / ${p.interval}` };
}

function PriceLine({ prices, id }: { prices: Prices; id: string }) {
  const p = (prices.plans as Record<string, { amount: number; currency: string; interval: string } | null>)[id];
  if (!p) return <p className="mt-4 h-9 text-sm text-muted-foreground">Free trial, then per seat</p>;
  const { amount, per } = money(p);
  return (
    <p className="mt-4 flex h-9 items-baseline gap-1.5">
      <span className="font-display text-4xl">{amount}</span>
      <span className="text-sm text-muted-foreground">{per}</span>
    </p>
  );
}

export default async function PricingPage() {
  const prices = await loadPrices();
  return (
    <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
      <div className="text-center">
        <h1 className="font-display text-5xl tracking-tight">Pricing</h1>
        <p className="mt-3 text-muted-foreground">Every plan starts with a free trial. Pay per seat when you are ready.</p>
      </div>

      <div className="mt-12 grid gap-4 md:grid-cols-3">
        {PLANS.map((p) => (
          <div
            key={p.id}
            className={cn('flex flex-col rounded-2xl border bg-card p-6', 'featured' in p ? 'border-brand/60 shadow-lg' : 'border-border')}
          >
            <div className="flex items-center justify-between">
              <h2 className="font-display text-2xl">{p.name}</h2>
              <span className="font-mono text-xs text-muted-foreground">{p.seats}</span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{p.blurb}</p>
            {p.id === 'firm' ? <p className="mt-4 h-9 text-sm text-muted-foreground">Volume pricing</p> : <PriceLine prices={prices} id={p.id} />}
            <Button asChild className="mt-6" variant={'featured' in p ? 'default' : 'outline'}>
              <Link href={p.href}>{p.cta}</Link>
            </Button>
          </div>
        ))}
      </div>

      <div className="mt-16 rounded-2xl border border-border bg-card p-6">
        <h2 className="font-medium">Every plan includes</h2>
        <ul className="mt-4 grid gap-x-8 gap-y-2.5 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <li key={f} className="flex items-start gap-2">
              <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-brand" />
              {f}
            </li>
          ))}
        </ul>
      </div>

      <div className="mx-auto mt-16 max-w-2xl space-y-6">
        <h2 className="font-display text-3xl tracking-tight">Seats, answered</h2>
        {[
          ['What is a seat?', 'One person who can sign in to your firm: an owner, an admin or a lawyer. A pending invitation holds a seat until it is accepted or revoked.'],
          ['What happens when we run out?', 'Invitations stop at the seat limit. An admin adds seats in Settings → Billing, and the new seat is usable at once.'],
          ['Can we remove seats?', 'Yes. Remove a member first, then lower the seat count in the billing portal.'],
        ].map(([q, a]) => (
          <div key={q}>
            <h3 className="font-medium">{q}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{a}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
