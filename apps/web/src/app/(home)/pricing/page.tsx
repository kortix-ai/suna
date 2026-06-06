'use client';

import { KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { Button } from '@/components/ui/marketing/button';
import KortixGrid from '@/components/ui/marketing/gridder';
import { ArrowRight, Check, Minus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Fragment } from 'react';
import { PiCheckCircleFill } from 'react-icons/pi';

const DEMO_URL = '/enterprise';
const START_URL = '/auth';
const GITHUB_URL = 'https://github.com/kortix-ai/suna';

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
  if (v === true) return <PiCheckCircleFill className="text-foreground mx-auto size-4" />;
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
    <div className="bg-background relative pt-28 sm:pt-40">
      <div className="mx-auto max-w-5xl px-2 md:px-0">
        <div className="mx-auto text-center">
          <h2 className="text-3xl font-medium text-balance md:text-4xl lg:text-5xl lg:tracking-tight">
            {tHardcodedUi.raw('appHomePricingPage.line107JsxTextStartFreeScaleWhenYouAposReReady')}
          </h2>
          <p className="text-muted-foreground mx-auto mt-4 max-w-4xl text-lg text-balance">
            {tHardcodedUi.raw(
              'appHomePricingPage.line108JsxTextSelfHostTheWholePlatformForFreeMove',
            )}
          </p>
        </div>
        <div className="@container space-y-8 pt-16">
          <div className="mx-auto max-w-sm rounded-xl border @4xl:max-w-full">
            <div className="grid *:p-8 @4xl:grid-cols-3">
              <div className="row-span-4 grid grid-rows-subgrid gap-8 @max-4xl:p-9">
                <div className="self-end">
                  <div data-slot="card-title" className="text-lg font-medium tracking-tight">
                    {PLANS[0].name}
                  </div>
                  <div className="text-muted-foreground mt-1 text-sm text-balance">
                    {PLANS[0].note}
                  </div>
                </div>
                <div>
                  <span
                    className="text-4xl"
                    style={{
                      fontKerning: 'none',
                    }}
                  >
                    {PLANS[0].price}
                  </span>
                </div>

                <Button variant="outline" asChild>
                  <Link href={PLANS[0].href}>{PLANS[0].cta}</Link>
                </Button>
                <ul role="list" className="flex flex-col space-y-3 text-left text-sm">
                  {PLANS[0].features.map((feature) => (
                    <li
                      key={feature}
                      className="flex items-center justify-start gap-2 first:font-medium"
                    >
                      <Check className="text-foreground size-4" />
                      {feature}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="ring-border bg-border/60 dark:bg-card row-span-4 grid grid-rows-subgrid gap-8 rounded-(--radius) shadow-xl ring-1 shadow-black/6.5 backdrop-blur @max-4xl:mx-1 @4xl:my-2">
                <div className="self-end">
                  <div data-slot="card-title" className="text-lg font-medium tracking-tight">
                    {PLANS[1].name}
                  </div>
                  <div
                    data-slot="card-description"
                    className="text-muted-foreground mt-1 text-sm text-balance"
                  >
                    {PLANS[1].note}
                  </div>
                </div>
                <div className="flex min-w-0 items-baseline gap-2">
                  <span
                    className="text-4xl"
                    style={{
                      fontKerning: 'none',
                    }}
                  >
                    {PLANS[1].price}
                  </span>
                  <div className="text-muted-foreground text-sm">{PLANS[1].unit}</div>
                </div>
                <Button asChild>
                  <Link href={PLANS[1].href}>{PLANS[1].cta}</Link>
                </Button>
                <ul role="list" className="space-y-3 text-sm">
                  {PLANS[1].features.map((feature) => (
                    <li
                      key={feature}
                      className="flex items-center justify-start gap-2 first:font-medium"
                    >
                      <Check className="text-foreground size-4" />
                      {feature}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="row-span-4 grid grid-rows-subgrid gap-8 @max-4xl:p-9">
                <div className="self-end">
                  <div data-slot="card-title" className="text-lg font-medium tracking-tight">
                    {PLANS[2].name}
                  </div>
                  <div
                    data-slot="card-description"
                    className="text-muted-foreground mt-1 text-sm text-balance"
                  >
                    {PLANS[2].note}
                  </div>
                </div>
                <div>
                  <span className="text-4xl">{PLANS[2].price}</span>
                </div>
                <Button variant="outline" asChild>
                  <Link href={PLANS[2].href}>{PLANS[2].cta}</Link>
                </Button>
                <ul role="list" className="space-y-3 text-sm">
                  {PLANS[2].features.map((feature) => (
                    <li
                      key={feature}
                      className="flex items-center justify-start gap-2 first:font-medium"
                    >
                      <Check className="text-foreground size-4" />
                      {feature}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>

          <p className="text-muted-foreground text-center text-sm">
            {tHardcodedUi.raw(
              'appHomePricingPage.line138JsxTextCloudIsPerSeatUsageBasedComputeYou',
            )}
          </p>
        </div>

        <section className="py-16 md:py-32">
          <div className="w-full overflow-auto lg:overflow-visible">
            <table className="w-[200vw] border-separate border-spacing-x-3 md:w-full dark:[--color-muted:var(--color-zinc-900)]">
              <thead className="bg-background sticky top-0">
                <tr className="*:py-4 *:text-left *:font-medium">
                  <th className="lg:w-2/5">
                    {tHardcodedUi.raw('appHomePricingPage.line145JsxTextComparePlans')}
                  </th>
                  <th>
                    <span className="block text-center">
                      {tHardcodedUi.raw('appHomePricingPage.line153JsxTextOpenSource')}
                    </span>
                  </th>
                  <th>
                    <span className="block text-center">Cloud</span>
                  </th>
                  <th>
                    <span className="block text-center">Enterprise</span>
                  </th>
                </tr>
              </thead>
              <tbody className="text-caption text-sm">
                {COMPARE.map((group) => (
                  <Fragment key={group.section}>
                    <tr className="*:py-3">
                      <td className="text-muted-foreground flex items-center gap-2 font-medium">
                        <span>{group.section}</span>
                      </td>
                      <td></td>
                      <td></td>
                      <td></td>
                    </tr>
                    {group.rows.map(([label, a, b, c]) => (
                      <tr key={label} className="*:border-b *:py-6">
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

        <section className="border-border/50 border-t px-4 py-16 sm:py-24">
          <div className="space-y-8">
            <h2 className="text-foreground text-2xl leading-tight font-medium tracking-tight sm:text-3xl">
              {tHardcodedUi.raw('appHomePricingPage.line183JsxTextPricingQuestions')}
            </h2>
            <div className="divide-border divide-y">
              {FAQ.map(([q, a]) => (
                <div key={q} className="py-5">
                  <h3 className="text-foreground text-sm font-semibold">{q}</h3>
                  <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">{a}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="cta" className="relative mx-auto max-w-6xl px-6 py-16 sm:py-24">
          <div className="border-border bg-card relative overflow-hidden rounded-sm border text-center">
            <div className="flex grid-cols-12 flex-col-reverse gap-2 md:grid">
              <div className="col-span-4 flex flex-col items-start justify-start p-6 *:text-left">
                <h2 className="text-foreground text-2xl leading-tight font-medium tracking-tight sm:text-3xl">
                  {tHardcodedUi.raw('appHomePage.line331JsxTextGiveYourCompanyAWorkforce')}
                </h2>

                <ul className="mt-6 space-y-3 pb-8">
                  {(
                    tHardcodedUi.raw(
                      'appHomePage.line334JsxTextFreeToSelfHostManagedCloudFrom20',
                    ) as string[]
                  ).map((line, index) => (
                    <li
                      key={line}
                      className="text-muted-foreground flex items-start gap-3 text-sm leading-relaxed"
                    >
                      <KortixAsterisk index={index} />
                      {line}
                    </li>
                  ))}
                </ul>

                <div className="mt-auto grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
                  <Button size="lg" className="w-full" asChild>
                    <Link href={DEMO_URL}>
                      {tHardcodedUi.raw('appHomePricingPage.line205JsxTextRequestDemo')}
                      <ArrowRight className="size-3.5" />
                    </Link>
                  </Button>
                  <Button asChild size="lg" className="w-full" variant="accent">
                    <Link href={START_URL}>
                      {tHardcodedUi.raw('appHomePricingPage.line206JsxTextGetStarted')}
                    </Link>
                  </Button>
                </div>
              </div>
              <div className="col-span-8 mask-y-from-90% mask-x-from-90%">
                <KortixGrid count={45} cols={8} seed={4622} />
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
