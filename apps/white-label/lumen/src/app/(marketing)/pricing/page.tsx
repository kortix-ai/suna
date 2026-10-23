import { api } from '@convex/_generated/api';
import { cn } from '@kortix/ui';
import { CtaBand } from '@/components/marketing/bands';
import { Container, PillLink, Section } from '@/components/marketing/parts';
import { CheckIcon } from '@phosphor-icons/react/dist/ssr';
import { fetchAction } from 'convex/nextjs';
import type { FunctionReturnType } from 'convex/server';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Pricing' };
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
  { id: 'firm', name: 'Firm', seats: '26+ seats', blurb: 'For larger practices with several teams.', cta: 'Talk to us', href: '/demo' },
] as const;

// Plans differ by seats only: every plan includes every feature.
const FEATURES = [
  'Assistant with cited answers',
  'Vault for PDF, Word and text documents',
  'Tabular review',
  'Workflows: playbook review, diligence, drafting, your own',
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
  if (!p) return <p className="mt-8 h-14 text-[15px] text-muted-foreground">Free trial, then per seat</p>;
  const { amount, per } = money(p);
  return (
    <p className="mt-8 flex h-14 items-baseline gap-2">
      <span className="font-display text-[56px] leading-none font-[360] tracking-[-0.05em]">{amount}</span>
      <span className="text-[14px] text-muted-foreground">{per}</span>
    </p>
  );
}

export default async function PricingPage() {
  const prices = await loadPrices();
  return (
    <>
      <Section rule={false} className="pt-20! pb-16! md:pt-28!">
        <Container className="flex flex-col items-center text-center">
          <h1 className="display-xl text-[clamp(4rem,10vw,8rem)]!">Pricing</h1>
          <p className="mt-6 max-w-md text-[18px] text-muted-foreground">Every plan starts with a free trial and includes every feature. Pay per seat when you are ready.</p>
        </Container>
      </Section>

      <Container>
        <div className="grid border-t border-hairline md:grid-cols-3">
          {PLANS.map((p, i) => (
            <div key={p.id} className={cn('flex flex-col border-b border-hairline py-10 md:border-b-0 md:px-10', i > 0 && 'md:border-l')}>
              <div className="flex items-baseline justify-between">
                <h2 className="display-xs">{p.name}</h2>
                {'featured' in p && <span className="rounded-full bg-lamp/15 px-2.5 py-0.5 text-[12px] font-medium">Most firms</span>}
              </div>
              <p className="mt-2 text-[15px] text-muted-foreground">
                {p.blurb} <span className="font-mono text-[12px]">{p.seats}</span>
              </p>
              {p.id === 'firm' ? <p className="mt-8 h-14 text-[15px] text-muted-foreground">Volume pricing</p> : <PriceLine prices={prices} id={p.id} />}
              <PillLink href={p.href} variant={'featured' in p ? 'solid' : 'outline'} className="mt-8 justify-center">
                {p.cta}
              </PillLink>
            </div>
          ))}
        </div>
      </Container>

      <Section className="mt-24">
        <Container className="grid gap-12 lg:grid-cols-12">
          <h2 className="display-sm lg:col-span-4">Every plan includes</h2>
          <ul className="grid gap-x-10 border-t border-hairline sm:grid-cols-2 lg:col-span-8">
            {FEATURES.map((f) => (
              <li key={f} className="flex items-center gap-3 border-b border-hairline py-4 text-[16px]">
                <CheckIcon aria-hidden className="size-4 shrink-0 text-verified" />
                {f}
              </li>
            ))}
          </ul>
        </Container>
      </Section>

      <Section>
        <Container className="grid gap-12 lg:grid-cols-12">
          <h2 className="display-sm lg:col-span-4">Seats, answered</h2>
          <div className="space-y-10 lg:col-span-8">
            {[
              ['What is a seat?', 'One person who can sign in to your firm: an owner, an admin or a lawyer. A pending invitation holds a seat until it is accepted or revoked.'],
              ['What happens when we run out?', 'Invitations stop at the seat limit. An admin adds seats in Settings → Billing, and the new seat is usable at once.'],
              ['Can we remove seats?', 'Yes. Remove a member first, then lower the seat count in the billing portal.'],
            ].map(([q, a]) => (
              <div key={q} className="border-t border-hairline pt-6">
                <h3 className="text-[20px] font-[470] tracking-[-0.025em]">{q}</h3>
                <p className="mt-2 text-[16px] leading-[1.5] text-muted-foreground">{a}</p>
              </div>
            ))}
          </div>
        </Container>
      </Section>
      <CtaBand />
    </>
  );
}
