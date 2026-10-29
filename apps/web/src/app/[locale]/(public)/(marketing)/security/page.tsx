import Link from '@/components/site-link';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { Band, Heading } from '@/features/marketing/kit/page-frame';
import { Seal } from '@/features/marketing/kit/seal';
import { FaqSection } from '@/features/marketing/landing-sections/faq-section';
import { LayerTabs } from '@/features/marketing/security-page/layer-tabs';
import {
  enforcement as sourceenforcement,
  faqItems as sourcefaqItems,
  pillars as sourcepillars,
  trust as sourcetrust,
} from '@/features/marketing/security-page/model';
import { SecurityHero } from '@/features/marketing/security-page/security-hero';
import { MARKETING_RELEASE_TRANSLATION_KEYS } from '@/i18n/marketing-release-translation-keys.generated';
import { useTranslations } from '@/i18n/use-translations';
import { localizeUiCatalog } from '@kortix/ui/i18n';
import {
  BuildingsIcon,
  CheckIcon,
  CloudIcon,
  CodeIcon,
  CpuIcon,
  HardDrivesIcon,
  IdentificationBadgeIcon,
  KeyIcon,
  ListChecksIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react/dist/ssr';
import type { ComponentType, ReactNode } from 'react';

/**
 * `/security`: the security model in the home page's rhythm. Hero with one
 * walkthrough of the model, four pillars, one tab per layer, what enforces
 * each rule, a trust band, then the security FAQ.
 *
 * Copy: `features/marketing/security-page/model.ts`, which cites the code or
 * doc behind every line. English only for now.
 */

type Glyph = ComponentType<{ className?: string }>;

const PILLAR_ICONS: Record<string, Glyph> = {
  computer: CpuIcon,
  identity: IdentificationBadgeIcon,
  credentials: KeyIcon,
  record: ListChecksIcon,
};

const TRUST_ICONS: Glyph[] = [
  CloudIcon,
  HardDrivesIcon,
  BuildingsIcon,
  CodeIcon,
  UsersThreeIcon,
  CpuIcon,
];

function Pillars() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { pillars } = localizeUiCatalog(
    { pillars: sourcepillars },
    tMarketing,
    MARKETING_RELEASE_TRANSLATION_KEYS,
  );

  return (
    <section id="pillars" className="scroll-mt-16 py-14 lg:py-20">
      <Heading title={pillars.title} titleMuted={pillars.titleMuted} />
      <Band className="mt-12">
        <ul className="bg-border grid grid-cols-1 gap-px sm:grid-cols-2 xl:grid-cols-4">
          {pillars.items.map(({ id, name, line, facts }) => {
            const Icon = PILLAR_ICONS[id];
            return (
              <li key={id} className="bg-background flex flex-col gap-5 p-6 lg:p-10">
                <Icon className="text-foreground size-6" aria-hidden />
                <h3 className="text-foreground text-2xl font-medium tracking-tight text-balance">
                  {name}
                  <span className="text-muted-foreground mt-1 block text-lg leading-snug">
                    {line}
                  </span>
                </h3>
                <ul className="mt-auto flex flex-col gap-2 text-sm">
                  {facts.map((fact) => (
                    <li key={fact} className="text-foreground flex items-start gap-2">
                      <CheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                      {fact}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      </Band>
    </section>
  );
}

/** A rule with a permission name in it: the name in mono. */
function Rule({ text }: { text: string }): ReactNode {
  const [before, name, after] = text.split(/(project\.[\w.]+)/);
  return name ? (
    <>
      {before}
      <code className="font-mono text-sm">{name}</code>
      {after}
    </>
  ) : (
    text
  );
}

/** Literal codes (403, connector_egress_blocked) in mono; plain words stay sans. */
function Deny({ text }: { text: string }): ReactNode {
  return /\d|_/.test(text) ? <code className="font-mono text-xs">{text}</code> : text;
}

function Enforcement() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { enforcement } = localizeUiCatalog(
    { enforcement: sourceenforcement },
    tMarketing,
    MARKETING_RELEASE_TRANSLATION_KEYS,
  );

  const [rule, by, deny] = enforcement.head;
  return (
    <section id="enforcement" className="scroll-mt-16 py-14 lg:py-20">
      <Heading title={enforcement.title} titleMuted={enforcement.titleMuted} />
      <Band className="mt-12">
        <div className="px-4 py-6 lg:px-11 lg:py-10">
          <table className="hidden w-full border-collapse text-left md:table">
            <caption className="sr-only">{enforcement.title}</caption>
            <thead>
              <tr className="border-b">
                <th
                  scope="col"
                  className="text-muted-foreground w-5/12 py-3 pr-4 text-sm font-normal"
                >
                  {rule}
                </th>
                <th
                  scope="col"
                  className="text-muted-foreground w-4/12 px-4 py-3 text-sm font-normal"
                >
                  {by}
                </th>
                <th scope="col" className="text-muted-foreground px-4 py-3 text-sm font-normal">
                  {deny}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {enforcement.rows.map(([r, b, d]) => (
                <tr key={r}>
                  <th scope="row" className="text-foreground py-4 pr-4 text-base font-normal">
                    <Rule text={r} />
                  </th>
                  <td className="text-muted-foreground px-4 py-4 text-sm">{b}</td>
                  <td className="text-foreground px-4 py-4 text-sm">
                    <Deny text={d} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="divide-y md:hidden">
            {enforcement.rows.map(([r, b, d]) => (
              <li key={r} className="flex flex-col gap-1 py-4">
                <span className="text-foreground text-base">
                  <Rule text={r} />
                </span>
                <span className="text-muted-foreground text-sm">{b}</span>
                <span className="text-foreground text-sm">
                  <Deny text={d} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      </Band>
    </section>
  );
}

/** The home page's trust band, for hosting and compliance: dark in both themes. */
function Trust() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { trust } = localizeUiCatalog(
    { trust: sourcetrust },
    tMarketing,
    MARKETING_RELEASE_TRANSLATION_KEYS,
  );

  return (
    <section id="trust" className="scroll-mt-16 py-14 lg:py-20">
      <div className="kx-rail-fade border-y px-4 lg:px-17">
        <div className="dark bg-muted text-foreground px-6 py-10 lg:px-11 lg:py-16">
          <h2 className="text-xl font-medium tracking-tight text-balance md:text-2xl lg:text-3xl">
            {trust.title}
            <span className="text-muted-foreground block">{trust.titleMuted}</span>
          </h2>
          <ul className="bg-border mt-10 grid grid-cols-1 gap-px border sm:grid-cols-2 lg:mt-12 lg:grid-cols-3">
            {trust.cells.map(({ k, v }, i) => {
              const Icon = TRUST_ICONS[i];
              return (
                <li key={k} className="bg-muted flex flex-col gap-3 p-5 lg:p-6">
                  <Icon className="size-7" aria-hidden />
                  <h3 className="mt-1 text-base font-medium">{k}</h3>
                  <p className="text-muted-foreground text-sm text-pretty">{v}</p>
                </li>
              );
            })}
            <li className="bg-muted flex flex-col items-start justify-between gap-6 p-5 sm:col-span-2 sm:flex-row sm:items-center lg:col-span-3 lg:p-6">
              <div className="flex items-center gap-5">
                <Seal
                  name="SOC 2"
                  detail="Type I"
                  note="Verified"
                  ornament="double"
                  className="text-foreground size-20 shrink-0"
                />
                <div>
                  <p className="text-base font-medium">{trust.seal}</p>
                  <p className="text-muted-foreground mt-1 text-sm">{trust.sealNote}</p>
                </div>
              </div>
              <MarketingButton size="md" className="hit-area-y-1 shrink-0" asChild>
                <Link href="/contact">Bring us your review</Link>
              </MarketingButton>
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}

export default function SecurityPage(): ReactNode {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { faqItems } = localizeUiCatalog(
    { faqItems: sourcefaqItems },
    tMarketing,
    MARKETING_RELEASE_TRANSLATION_KEYS,
  );

  return (
    <main className="bg-background relative mx-auto w-full max-w-[1440px]">
      <div
        aria-hidden
        className="bg-border pointer-events-none absolute inset-y-0 left-4 z-10 w-px lg:left-17"
      />
      <div
        aria-hidden
        className="bg-border pointer-events-none absolute inset-y-0 right-4 z-10 w-px lg:right-17"
      />
      <SecurityHero />
      <Pillars />
      <LayerTabs />
      <Enforcement />
      <Trust />
      <FaqSection
        title="Security questions."
        titleMuted="Answered from the code."
        items={faqItems}
      />
    </main>
  );
}
