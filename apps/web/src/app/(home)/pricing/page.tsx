import { Fragment } from 'react';
import Link from 'next/link';
import { Check, Minus, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Reveal } from '@/components/home/reveal';

const DEMO_URL = '/enterprise';
const START_URL = '/auth';
const GITHUB_URL = 'https://github.com/kortix-ai/suna';

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">{children}</span>;
}

const PLANS = [
  {
    name: 'Open Source',
    price: 'Free',
    note: 'Self-host the full platform, forever.',
    cta: 'View on GitHub',
    href: GITHUB_URL,
    external: true,
    highlight: false,
    features: ['Self-host anywhere — your infra', 'Bring your own models', 'All agents, skills & automations', '3,000+ integrations', 'Community support'],
  },
  {
    name: 'Cloud',
    price: '$20',
    unit: '/ seat / mo + usage',
    note: 'Your command center, managed for you.',
    cta: 'Get started',
    href: START_URL,
    external: false,
    highlight: true,
    features: ['Everything in Open Source', 'Managed cloud — nothing to run', 'Hosted sandboxes & compute', 'SSO and team workspaces', 'Usage-based compute — pay for what runs'],
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    note: 'For companies running on AI at scale.',
    cta: 'Request demo',
    href: DEMO_URL,
    external: false,
    highlight: false,
    features: ['Everything in Cloud', 'On-prem, VPC, or air-gapped', 'Advanced RBAC, policies & SCIM', 'Audit logs, SAML SSO, DPA', 'Dedicated support & SLAs'],
  },
];

type Cell = string | boolean;
const COMPARE: { section: string; rows: [string, Cell, Cell, Cell][] }[] = [
  {
    section: 'Platform',
    rows: [
      ['Agents, skills & automations', true, true, true],
      ['3,000+ integrations', true, true, true],
      ['Channels (Slack, Teams, Telegram…)', true, true, true],
      ['Bring your own models', true, true, true],
      ['Persistent memory', true, true, true],
    ],
  },
  {
    section: 'Hosting & compute',
    rows: [
      ['Hosting', 'Self-host', 'Managed cloud', 'Cloud · VPC · on-prem'],
      ['Managed sandboxes & compute', false, true, true],
      ['Team members', 'Unlimited', 'Per seat', 'Unlimited'],
    ],
  },
  {
    section: 'Security & control',
    rows: [
      ['SSO', false, 'Google · GitHub', 'SAML · SCIM'],
      ['Roles & permissions', 'Basic', 'Teams', 'Advanced RBAC & policies'],
      ['Secrets manager', true, true, 'Network-level policies'],
      ['Audit logs', false, true, 'Advanced + export'],
      ['Security review & DPA', false, false, true],
    ],
  },
  {
    section: 'Support',
    rows: [['Support', 'Community', 'Standard', 'Dedicated + SLA']],
  },
];

function CompareCell({ v }: { v: Cell }) {
  if (v === true) return <Check className="size-4 text-foreground mx-auto" />;
  if (v === false) return <Minus className="size-4 text-muted-foreground/40 mx-auto" />;
  return <span className="text-[13px] text-muted-foreground">{v}</span>;
}

const FAQ: [string, string][] = [
  ['Can I really run it for free?', 'Yes. The platform is open and self-hostable — run it on your own infrastructure at no per-seat cost, bring your own model keys, and keep everything in your perimeter.'],
  ['How does Cloud pricing work?', 'Cloud is a flat price per seat plus usage-based compute. You pay for the agent runs your team actually triggers — no charge for idle time.'],
  ['What counts as usage?', 'Compute for running agent sessions, and any models you run through our cloud. Bring your own model keys and you only pay for the compute.'],
  ['Do you offer on-prem or air-gapped?', 'Yes — Enterprise can run in your own cloud (VPC) or fully air-gapped, with single-tenant deployment and a security review.'],
  ['Which models can we use?', 'Any. Bring your own keys or subscription for Anthropic, OpenAI, and others, or use Kortix cloud compute.'],
];

export default function PricingPage() {
  return (
    <div className="relative bg-background pt-28 sm:pt-32">

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-6 pt-8 pb-14 text-center">
        <Reveal>
          <Eyebrow>Pricing</Eyebrow>
          <h1 className="mt-4 text-4xl sm:text-5xl md:text-6xl font-medium tracking-tight text-foreground leading-[1.04]">Start free. Scale when you&apos;re ready.</h1>
          <p className="mt-5 text-base sm:text-lg text-muted-foreground leading-relaxed max-w-2xl mx-auto">Self-host the whole platform for free. Move to managed cloud per seat, and to enterprise when you need on-prem and advanced controls.</p>
        </Reveal>
      </section>

      {/* Plans */}
      <section className="max-w-6xl mx-auto px-6 pb-8">
        <Reveal delay={0.05}>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 items-start">
            {PLANS.map((p) => (
              <div key={p.name} className={p.highlight ? 'rounded-3xl border-2 border-foreground bg-card/40 p-6 sm:p-7 shadow-lg relative' : 'rounded-3xl border border-border bg-card/40 p-6 sm:p-7'}>
                {p.highlight && <span className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-foreground text-background text-[11px] font-medium">Most popular</span>}
                <h3 className="text-sm font-semibold text-foreground">{p.name}</h3>
                <div className="mt-3 flex items-baseline gap-1.5">
                  <span className="text-4xl font-medium tracking-tight text-foreground">{p.price}</span>
                  {p.unit && <span className="text-[13px] text-muted-foreground">{p.unit}</span>}
                </div>
                <p className="mt-2 text-[13px] text-muted-foreground leading-relaxed">{p.note}</p>
                <Button asChild size="lg" variant={p.highlight ? 'default' : 'outline'} className="mt-5 w-full h-11 rounded-full text-sm">
                  {p.external ? <a href={p.href} target="_blank" rel="noopener noreferrer">{p.cta}</a> : <Link href={p.href}>{p.cta}</Link>}
                </Button>
                <ul className="mt-6 space-y-2.5">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-start gap-2.5 text-[13px] text-muted-foreground"><Check className="size-4 mt-0.5 text-foreground/70 shrink-0" />{f}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Reveal>
        <Reveal delay={0.1}>
          <p className="mt-6 text-center text-[13px] text-muted-foreground">Cloud is per seat + usage-based compute. You only pay for what your agents actually run.</p>
        </Reveal>
      </section>

      {/* Comparison */}
      <section className="max-w-6xl mx-auto px-6 py-16 sm:py-24 border-t border-border/50">
        <Reveal>
          <h2 className="text-2xl sm:text-3xl font-medium tracking-tight text-foreground leading-tight mb-10">Compare plans</h2>
        </Reveal>
        <Reveal delay={0.05}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-3 pr-4 w-[34%]" />
                  <th className="py-3 px-4 text-sm font-semibold text-foreground text-center">Open Source</th>
                  <th className="py-3 px-4 text-sm font-semibold text-foreground text-center">Cloud</th>
                  <th className="py-3 px-4 text-sm font-semibold text-foreground text-center">Enterprise</th>
                </tr>
              </thead>
              <tbody>
                {COMPARE.map((group) => (
                  <Fragment key={group.section}>
                    <tr>
                      <td colSpan={4} className="pt-7 pb-2 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">{group.section}</td>
                    </tr>
                    {group.rows.map(([label, a, b, c]) => (
                      <tr key={label} className="border-b border-border/50">
                        <td className="py-3 pr-4 text-[13px] text-foreground">{label}</td>
                        <td className="py-3 px-4 text-center"><CompareCell v={a} /></td>
                        <td className="py-3 px-4 text-center"><CompareCell v={b} /></td>
                        <td className="py-3 px-4 text-center"><CompareCell v={c} /></td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </Reveal>
      </section>

      {/* FAQ */}
      <section className="max-w-3xl mx-auto px-6 py-16 sm:py-24 border-t border-border/50">
        <Reveal>
          <h2 className="text-2xl sm:text-3xl font-medium tracking-tight text-foreground leading-tight mb-8">Pricing questions</h2>
        </Reveal>
        <div className="divide-y divide-border/60">
          {FAQ.map(([q, a]) => (
            <Reveal key={q}>
              <div className="py-5">
                <h3 className="text-sm font-semibold text-foreground">{q}</h3>
                <p className="mt-1.5 text-[14px] text-muted-foreground leading-relaxed">{a}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-5xl mx-auto px-6 py-20 sm:py-28 border-t border-border/50 text-center">
        <Reveal>
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-medium tracking-tight text-foreground leading-tight">Start free today.</h2>
          <p className="mt-4 text-base sm:text-lg text-muted-foreground max-w-xl mx-auto">Self-host in minutes, or have us walk you through Cloud and Enterprise in a live demo.</p>
        </Reveal>
        <Reveal delay={0.1}>
          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
            <Button asChild size="lg" className="h-12 px-8 text-sm rounded-full"><Link href={DEMO_URL}>Request demo<ArrowRight className="ml-1.5 size-3.5" /></Link></Button>
            <Button asChild size="lg" variant="outline" className="h-12 px-7 text-sm rounded-full"><Link href={START_URL}>Get started</Link></Button>
          </div>
        </Reveal>
      </section>
    </div>
  );
}
