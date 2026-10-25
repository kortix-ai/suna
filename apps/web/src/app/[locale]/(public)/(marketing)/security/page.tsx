import Link from '@/components/site-link';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { Band, Block, CellGrid, Heading, KeyRows, PageFrame, PageHero, SpecGrid } from '@/features/marketing/kit/page-frame';
import { Seal } from '@/features/marketing/kit/seal';
import { ApprovalTabs } from '@/features/marketing/security-page/approval-tabs';
import { getLocalizedSecurityContent } from '@/features/marketing/security-page/content';
import { useTranslations } from '@/i18n/use-translations';
import type { ReactNode } from 'react';

/**
 * `/security`: the page a security reviewer reads before they let anyone else
 * in the building use Kortix.
 *
 * Copy lives in `features/marketing/security-page/content.ts` and every claim on
 * it is traced to code in that file's header, including the seven places where
 * a neighbouring page or the `kortix-brand` skill says more than the code
 * supports. Read that header before editing a single line here.
 *
 * Layout is the landing page's: one 1440px column between two hairline rails;
 * each section is a two-tone title (font-medium, 20/24/30px) and one line of
 * description, then a bordered band whose top and bottom hairlines cross the
 * page and fade past the rails (`kx-rail-fade`). Cells inside a band are split
 * by hairlines (`gap-px` over `bg-border`). No eyebrows, no reveal motion.
 *
 * The closing call to action is the footer's, so the page has no closing
 * section of its own.
 */

// The part of kortix.yaml each approval note is about (line ranges into
// control.yaml.lines). Keep in step with that array.
const APPROVAL_SLICES = {
  actions: [4, 19],
  conditions: [4, 11],
  percall: [4, 15],
  default: [0, 3],
} as const;

export default function SecurityPage(): ReactNode {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { audit, control, credentials, disclosure, hero, identity, isolation, landing, posture } =
    getLocalizedSecurityContent(tI18nComplete);

  return (
    <PageFrame>
      {/* Hero: the landing hero's type and spacing, then the four facts the
          rest of the page proves, as one row of cells. */}
      <section id="hero">
        <PageHero
          title={hero.title}
          titleMuted={hero.titleMuted}
          sub={hero.sub}
          actions={
            <>
              <MarketingButton variant="secondary" size="md" className="hit-area-y-1" asChild>
                <Link href={hero.ctaPrimaryHref}>{hero.ctaPrimary}</Link>
              </MarketingButton>
              <MarketingButton size="md" className="hit-area-y-1" asChild>
                <Link href={hero.ctaSecondaryHref}>{hero.ctaSecondary}</Link>
              </MarketingButton>
            </>
          }
        />
        <Band>
          <SpecGrid items={hero.specs} cols="lg:grid-cols-4" />
        </Band>
      </section>

      {/* 1 · Isolation: inside one session, and what stays out. */}
      <Block id="isolation">
        <Heading title={isolation.title} titleMuted={isolation.titleMuted} sub={isolation.sub} />
        <Band className="mt-12">
          <div className="grid grid-cols-1 md:grid-cols-2">
            {[isolation.inside, isolation.outside].map((side, i) => (
              <div key={side.label} className={i === 0 ? 'p-6 lg:p-11' : 'border-t p-6 md:border-t-0 md:border-l lg:p-11'}>
                <h3 className="text-foreground text-base font-medium first-letter:uppercase">{side.label}</h3>
                <ul className="mt-4 divide-y">
                  {side.items.map((item) => (
                    <li
                      key={item}
                      className={
                        i === 0 ? 'text-foreground py-3.5 text-sm text-pretty' : 'text-muted-foreground py-3.5 text-sm text-pretty'
                      }
                    >
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Band>
        <div className="mt-6">
          <KeyRows rows={isolation.rows} />
        </div>
      </Block>

      {/* 2 · Credentials: the five-step path a key takes. */}
      <Block id="credentials">
        <Heading title={credentials.title} titleMuted={credentials.titleMuted} sub={credentials.sub} />
        <Band className="mt-12">
          <CellGrid
            cols="lg:grid-cols-5"
            items={credentials.flow.map((step) => ({ id: step.n, n: step.n, k: step.k, v: step.v }))}
          />
        </Band>
        <div className="mt-6">
          <KeyRows rows={credentials.rows} />
        </div>
      </Block>

      {/* 3 · Identity: principals, the built-in roles, enterprise identity. */}
      <Block id="identity">
        <Heading title={identity.title} titleMuted={identity.titleMuted} sub={identity.sub} />
        <Band className="mt-12">
          <div className="grid grid-cols-1 md:grid-cols-2">
            {(
              [
                ['Account roles', identity.presets.account],
                ['Project roles', identity.presets.project],
              ] as const
            ).map(([scope, roles], i) => (
              <div key={scope} className={i === 0 ? 'p-6 lg:p-11' : 'border-t p-6 md:border-t-0 md:border-l lg:p-11'}>
                <h3 className="text-foreground text-base font-medium">{scope}</h3>
                <dl className="mt-4 divide-y">
                  {roles.map((role) => (
                    <div key={role.k} className="py-3.5">
                      <dt className="text-foreground text-sm font-medium">{role.k}</dt>
                      <dd className="text-muted-foreground mt-1 text-sm text-pretty">{role.v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        </Band>
        <div className="mt-6">
          <KeyRows
            rows={[
              {
                id: 'principals',
                k: 'Principals',
                v: <span className="font-mono">{identity.matrix.principals.join(', ')}</span>,
              },
              {
                id: 'resources',
                k: 'Resource types',
                v: <span className="font-mono">{identity.matrix.resources.join(', ')}</span>,
              },
              ...identity.enterprise.items,
              ...[identity.agents, identity.scoping].map((card) => ({ id: card.title, k: card.title, v: card.body })),
            ]}
          />
          <p className="text-muted-foreground px-8 pt-2 text-sm text-pretty lg:px-28">{identity.enterprise.note}</p>
        </div>
      </Block>

      {/* 4 · Control: the approval rules, as tabs over kortix.yaml. */}
      <Block id="control">
        <Heading title={control.title} titleMuted={control.titleMuted} sub={control.sub} />
        <Band className="mt-12">
          <ApprovalTabs notes={control.notes} title={control.yaml.title} lines={control.yaml.lines} slices={APPROVAL_SLICES} />
        </Band>
      </Block>

      {/* 5 · Change requests: four steps to main. */}
      <Block id="change-requests">
        <Heading title={landing.title} titleMuted={landing.titleMuted} sub={landing.sub} />
        <Band className="mt-12">
          <CellGrid
            cols="lg:grid-cols-4"
            items={landing.steps.map((step) => ({ id: step.n, n: step.n, k: step.title, v: step.body }))}
          />
        </Band>
      </Block>

      {/* 6 · Audit. */}
      <Block id="audit">
        <Heading title={audit.title} titleMuted={audit.titleMuted} sub={audit.sub} />
        <div className="mt-6">
          <KeyRows rows={audit.rows} />
        </div>
      </Block>

      {/* 7 · Posture: where it runs, and the honest compliance line. */}
      <Block id="posture">
        <Heading title={posture.title} titleMuted={posture.titleMuted} sub={posture.sub} />
        <Band className="mt-12">
          <CellGrid
            cols="lg:grid-cols-3"
            items={posture.deployments.map((item) => ({ id: item.id, k: item.k, v: item.v }))}
          />
        </Band>
        <div className="grid grid-cols-1 items-center gap-10 px-8 pt-12 lg:grid-cols-12 lg:px-28">
          <div className="lg:col-span-5">
            <h3 className="text-foreground text-base font-medium">{posture.compliance.label}</h3>
            <p className="text-muted-foreground mt-2 text-sm text-pretty">{posture.compliance.note}</p>
          </div>
          <ul className="flex flex-wrap items-center gap-4 lg:col-span-7 lg:justify-end">
            <li>
              <Seal name="SOC 2" detail="Type I" ornament="double" />
            </li>
            <li>
              <Seal name="SOC 2" detail="Type II" note="In progress" ornament="ticks" />
            </li>
            <li>
              <Seal name="GDPR" detail="Operated" ornament="stars" />
            </li>
          </ul>
        </div>
      </Block>

      {/* 8 · Disclosure. */}
      <Block id="disclosure">
        <Heading title={disclosure.title} titleMuted={disclosure.titleMuted} sub={disclosure.sub} />
        <Band className="mt-12">
          <div className="grid grid-cols-1 md:grid-cols-2">
            <div className="p-6 lg:p-11">
              <a
                href={`mailto:${disclosure.email}`}
                className="text-foreground hover:text-muted-foreground outline-ring font-mono text-lg transition-colors duration-moderate focus-visible:outline-2 focus-visible:outline-offset-4 sm:text-xl"
              >
                {disclosure.email}
              </a>
              <p className="text-muted-foreground mt-4 text-sm text-pretty">{disclosure.credit}</p>
            </div>
            <dl className="divide-y border-t p-6 md:border-t-0 md:border-l lg:p-11">
              {disclosure.slas.map((sla) => (
                <div key={sla.k} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3.5">
                  <dt className="text-foreground text-sm font-medium">{sla.k}</dt>
                  <dd className="text-muted-foreground text-sm">{sla.v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Band>
      </Block>
    </PageFrame>
  );
}
