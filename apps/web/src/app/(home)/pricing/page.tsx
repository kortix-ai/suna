'use client';

import { Button } from '@/components/ui/button';
import { ArrowRight, Check, Minus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Fragment } from 'react';

const DEMO_URL = '/enterprise';
const START_URL = '/auth';
const GITHUB_URL = 'https://github.com/kortix-ai/suna';

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
      {children}
    </span>
  );
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
    features: [
      'Self-host anywhere — your infra',
      'Bring your own models',
      'All agents, skills & automations',
      '3,000+ integrations',
      'Community support',
    ],
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
    features: [
      'Everything in Open Source',
      'Managed cloud — nothing to run',
      'Hosted sandboxes & compute',
      'SSO and team workspaces',
      'Usage-based compute — pay for what runs',
    ],
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    note: 'For companies running on AI at scale.',
    cta: 'Request demo',
    href: DEMO_URL,
    external: false,
    highlight: false,
    features: [
      'Everything in Cloud',
      'On-prem, VPC, or air-gapped',
      'Advanced RBAC, policies & SCIM',
      'Audit logs, SAML SSO, DPA',
      'Dedicated support & SLAs',
    ],
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
  if (v === true) return <Check className="text-foreground mx-auto size-4" />;
  if (v === false) return <Minus className="text-muted-foreground/40 mx-auto size-4" />;
  return <span className="text-muted-foreground text-sm">{v}</span>;
}

const FAQ: [string, string][] = [
  [
    'Can I really run it for free?',
    'Yes. The platform is open and self-hostable — run it on your own infrastructure at no per-seat cost, bring your own model keys, and keep everything in your perimeter.',
  ],
  [
    'How does Cloud pricing work?',
    'Cloud is a flat price per seat plus usage-based compute. You pay for the agent runs your team actually triggers — no charge for idle time.',
  ],
  [
    'What counts as usage?',
    'Compute for running agent sessions, and any models you run through our cloud. Bring your own model keys and you only pay for the compute.',
  ],
  [
    'Do you offer on-prem or air-gapped?',
    'Yes — Enterprise can run in your own cloud (VPC) or fully air-gapped, with single-tenant deployment and a security review.',
  ],
  [
    'Which models can we use?',
    'Any. Bring your own keys or subscription for Anthropic, OpenAI, and others, or use Kortix cloud compute.',
  ],
];

export default function PricingPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="bg-background relative pt-28 sm:pt-32">
      <section className="mx-auto max-w-5xl px-6 pt-8 pb-14 text-center">
        <Eyebrow>Pricing</Eyebrow>
        <h1 className="text-foreground mt-4 text-4xl leading-[1.04] font-medium tracking-tight sm:text-5xl md:text-6xl">
          {tHardcodedUi.raw('appHomePricingPage.line107JsxTextStartFreeScaleWhenYouAposReReady')}
        </h1>
        <p className="text-muted-foreground mx-auto mt-5 max-w-2xl text-base leading-relaxed sm:text-lg">
          {tHardcodedUi.raw('appHomePricingPage.line108JsxTextSelfHostTheWholePlatformForFreeMove')}
        </p>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-8">
        <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-3">
          {PLANS.map((p) => (
            <div
              key={p.name}
              className={
                p.highlight
                  ? 'border-foreground bg-card/40 relative rounded-3xl border-2 p-6 shadow-lg sm:p-7'
                  : 'border-border bg-card/40 rounded-3xl border p-6 sm:p-7'
              }
            >
              {p.highlight && (
                <span className="bg-foreground text-background absolute -top-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-xs font-medium">
                  {tHardcodedUi.raw('appHomePricingPage.line118JsxTextMostPopular')}
                </span>
              )}
              <h3 className="text-foreground text-sm font-semibold">{p.name}</h3>
              <div className="mt-3 flex items-baseline gap-1.5">
                <span className="text-foreground text-4xl font-medium tracking-tight">
                  {p.price}
                </span>
                {p.unit && <span className="text-muted-foreground text-sm">{p.unit}</span>}
              </div>
              <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{p.note}</p>
              <Button
                asChild
                size="lg"
                variant={p.highlight ? 'default' : 'outline'}
                className="mt-5 h-11 w-full rounded-full text-sm"
              >
                {p.external ? (
                  <a href={p.href} target="_blank" rel="noopener noreferrer">
                    {p.cta}
                  </a>
                ) : (
                  <Link href={p.href}>{p.cta}</Link>
                )}
              </Button>
              <ul className="mt-6 space-y-2.5">
                {p.features.map((f) => (
                  <li key={f} className="text-muted-foreground flex items-start gap-2.5 text-sm">
                    <Check className="text-foreground/70 mt-0.5 size-4 shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="text-muted-foreground mt-6 text-center text-sm">
          {tHardcodedUi.raw('appHomePricingPage.line138JsxTextCloudIsPerSeatUsageBasedComputeYou')}
        </p>
      </section>

      <section className="border-border/50 mx-auto max-w-6xl border-t px-6 py-16 sm:py-24">
        <h2 className="text-foreground mb-10 text-2xl leading-tight font-medium tracking-tight sm:text-3xl">
          {tHardcodedUi.raw('appHomePricingPage.line145JsxTextComparePlans')}
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse">
            <thead>
              <tr className="border-border border-b">
                <th className="w-[34%] py-3 pr-4 text-left" />
                <th className="text-foreground px-4 py-3 text-center text-sm font-semibold">
                  {tHardcodedUi.raw('appHomePricingPage.line153JsxTextOpenSource')}
                </th>
                <th className="text-foreground px-4 py-3 text-center text-sm font-semibold">
                  Cloud
                </th>
                <th className="text-foreground px-4 py-3 text-center text-sm font-semibold">
                  Enterprise
                </th>
              </tr>
            </thead>
            <tbody>
              {COMPARE.map((group) => (
                <Fragment key={group.section}>
                  <tr>
                    <td
                      colSpan={4}
                      className="text-muted-foreground pt-7 pb-2 font-mono text-xs tracking-wider uppercase"
                    >
                      {group.section}
                    </td>
                  </tr>
                  {group.rows.map(([label, a, b, c]) => (
                    <tr key={label} className="border-border/50 border-b">
                      <td className="text-foreground py-3 pr-4 text-sm">{label}</td>
                      <td className="px-4 py-3 text-center">
                        <CompareCell v={a} />
                      </td>
                      <td className="px-4 py-3 text-center">
                        <CompareCell v={b} />
                      </td>
                      <td className="px-4 py-3 text-center">
                        <CompareCell v={c} />
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="border-border/50 mx-auto max-w-3xl border-t px-6 py-16 sm:py-24">
        <h2 className="text-foreground mb-8 text-2xl leading-tight font-medium tracking-tight sm:text-3xl">
          {tHardcodedUi.raw('appHomePricingPage.line183JsxTextPricingQuestions')}
        </h2>
        <div className="divide-border/60 divide-y">
          {FAQ.map(([q, a]) => (
            <div key={q} className="py-5">
              <h3 className="text-foreground text-sm font-semibold">{q}</h3>
              <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">{a}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-border/50 mx-auto max-w-5xl border-t px-6 py-20 text-center sm:py-28">
        <h2 className="text-foreground text-3xl leading-tight font-medium tracking-tight sm:text-4xl md:text-5xl">
          {tHardcodedUi.raw('appHomePricingPage.line200JsxTextStartFreeToday')}
        </h2>
        <p className="text-muted-foreground mx-auto mt-4 max-w-xl text-base sm:text-lg">
          {tHardcodedUi.raw('appHomePricingPage.line201JsxTextSelfHostInMinutesOrHaveUsWalk')}
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button asChild size="lg" className="h-12 rounded-full px-8 text-sm">
            <Link href={DEMO_URL}>
              {tHardcodedUi.raw('appHomePricingPage.line205JsxTextRequestDemo')}
              <ArrowRight className="ml-1.5 size-3.5" />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline" className="h-12 rounded-full px-7 text-sm">
            <Link href={START_URL}>
              {tHardcodedUi.raw('appHomePricingPage.line206JsxTextGetStarted')}
            </Link>
          </Button>
        </div>
      </section>
    </div>
  );
}
