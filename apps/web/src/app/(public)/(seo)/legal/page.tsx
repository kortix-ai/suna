'use client';

import { useTranslations } from 'next-intl';

import { Separator } from '@/components/ui/separator';
import { DOC_BODY, DOC_GRID, DocRail, docRailItem } from '@/features/marketing/doc-rail';
import { cn } from '@/lib/utils';
import { ArrowUpRightIcon } from '@phosphor-icons/react';
import { m } from 'motion/react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type ReactNode } from 'react';

const LEGAL_LAST_UPDATED = 'April 8, 2026';

type LegalTab = 'privacy' | 'imprint';

function isLegalTab(value: string | null): value is LegalTab {
  return value === 'privacy' || value === 'imprint';
}

/**
 * Shared prose scale for the legal documents.
 *
 * `@tailwindcss/typography` is NOT installed in this app — `globals.css` only
 * registers `tailwind-scrollbar` and `tailwind-scrollbar-hide` — so the
 * `prose prose-sm dark:prose-invert` classes this page used to carry were
 * inert, which is why every element needed a hand-written `mb-6`. These
 * constants are the same solution `changelog/page.tsx` uses (`RELEASE_PROSE`):
 * one named scale, applied by the local atoms below.
 */
const PROSE = 'text-muted-foreground text-[15px] leading-7 text-pretty';

const LINK =
  'text-foreground decoration-foreground/25 hover:decoration-foreground/60 wrap-break-word underline underline-offset-4 transition-colors';

// ---------------------------------------------------------------------------
// Prose atoms
// ---------------------------------------------------------------------------

/** A titled block of a legal document. `scroll-mt-28` clears the fixed navbar. */
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-28">
      <h2 className="text-foreground text-lg font-medium tracking-tight text-balance">{title}</h2>
      <div className="mt-3 space-y-4">{children}</div>
    </section>
  );
}

function P({ children }: { children: ReactNode }) {
  return <p className={PROSE}>{children}</p>;
}

function Bullets({ children }: { children: ReactNode }) {
  return (
    <ul className={cn(PROSE, 'marker:text-muted-foreground/40 list-disc space-y-2 pl-5')}>
      {children}
    </ul>
  );
}

/**
 * "You directly provide it to us." → intro → bullets. The privacy policy
 * repeats this shape four times; naming it keeps the three parts locked to one
 * rhythm instead of drifting apart across copies.
 */
function Clause({ lead, intro, children }: { lead: string; intro?: string; children?: ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-foreground text-[15px] leading-7 font-medium text-pretty">{lead}</p>
      {intro ? <p className={PROSE}>{intro}</p> : null}
      {children}
    </div>
  );
}

/**
 * A postal address in the imprint. `<address>` is the correct element and
 * carries a UA italic that has to be reset.
 */
function AddressBlock({ label, lines }: { label: string; lines: string[] }) {
  return (
    <div>
      <dt className="text-foreground text-sm font-medium">{label}</dt>
      <dd className="mt-2">
        <address className={cn(PROSE, 'not-italic')}>
          {lines.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </address>
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

function Imprint() {
  const t = useTranslations('hardcodedUi');

  return (
    <div className="space-y-12">
      <Section
        id="company-information"
        title={t.raw('appLegalPage.line97JsxTextCompanyInformation')}
      >
        <P>
          <span className="text-foreground font-medium">
            {t.raw('appLegalPage.line101JsxTextKortixAiCorp')}
          </span>
          {' — '}
          {t.raw('appLegalPage.line103JsxTextIncorporatedInDelawareUnitedStates')}
        </P>

        {/* Two address blocks side by side from `sm` up. Stacked, these were
            eight consecutive <p> tags that read as one undifferentiated wall. */}
        <dl className="grid gap-6 pt-2 sm:grid-cols-2 sm:gap-x-10">
          <AddressBlock
            label={t.raw('appLegalPage.line105JsxTextPrincipalPlaceOfBusiness')}
            lines={[
              t.raw('appLegalPage.line107JsxTextText701TilleryStreet'),
              t.raw('appLegalPage.line108JsxTextUnit122521'),
              t.raw('appLegalPage.line109JsxTextAustinTx78702'),
              t.raw('appLegalPage.line110JsxTextUnitedStates'),
            ]}
          />
          <AddressBlock
            label={t.raw('appLegalPage.line112JsxTextRegisteredAgent')}
            lines={[
              t.raw('appLegalPage.line114JsxTextFirstbaseAgentLlc'),
              t.raw('appLegalPage.line115JsxTextText1007NOrangeSt4thFloorSuite1382'),
              t.raw('appLegalPage.line116JsxTextWilmingtonDe19801'),
              t.raw('appLegalPage.line117JsxTextUnitedStates'),
            ]}
          />
        </dl>
      </Section>

      <Section id="imprint-contact" title="Contact">
        <P>
          Email{' '}
          <a href="mailto:info@kortix.com" className={LINK}>
            {t.raw('appLegalPage.line130JsxTextInfoKortixCom')}
          </a>
          .
        </P>
      </Section>

      <Section
        id="responsible-for-content"
        title={t.raw('appLegalPage.line136JsxTextResponsibleForContent')}
      >
        <P>{t.raw('appLegalPage.line139JsxTextKortixAiCorpIsResponsibleForTheContent')}</P>
      </Section>

      <Section id="disclaimer" title="Disclaimer">
        <P>{t.raw('appLegalPage.line147JsxTextTheInformationProvidedOnThisWebsiteIsFor')}</P>
      </Section>
    </div>
  );
}

function PrivacyPolicy() {
  const t = useTranslations('hardcodedUi');

  return (
    <div className="space-y-12">
      <Section id="privacy" title="Privacy">
        <P>{t.raw('appLegalPage.line1541JsxTextOurCommitmentToPrivacyAndDataProtectionIs')}</P>
        <P>{t.raw('appLegalPage.line1551JsxTextReferencesToOurServicesAtKortixInThis')}</P>
        <P>
          {t.raw(
            'appLegalPage.line1560JsxTextKortixDoesNotCollectBiometricOrIdentifyingInformation',
          )}
        </P>
      </Section>

      <Section
        id="information-gathering"
        title={t.raw('appLegalPage.line1566JsxTextInformationGathering')}
      >
        <P>{t.raw('appLegalPage.line1569JsxTextWeLearnInformationAboutYouWhen')}</P>

        <Clause
          lead={t.raw('appLegalPage.line1573JsxTextYouDirectlyProvideItToUs')}
          intro={t.raw('appLegalPage.line1576JsxTextForExampleWeCollect')}
        >
          <Bullets>
            <li>
              {t.raw('appLegalPage.line1580JsxTextNameAndContactInformationWeCollectDetailsSuch')}
            </li>
            <li>{t.raw('appLegalPage.line1584JsxTextPaymentInformationIfYouMakeAPurchaseWe')}</li>
            <li>{t.raw('appLegalPage.line1589JsxTextContentAndFilesWeCollectAndRetainThe')}</li>
          </Bullets>
        </Clause>

        <Clause
          lead={t.raw('appLegalPage.line1597JsxTextWeCollectItAutomaticallyThroughOurProductsAnd')}
          intro={t.raw('appLegalPage.line1601JsxTextForInstanceWeCollect')}
        >
          <Bullets>
            <li>
              {t.raw('appLegalPage.line1605JsxTextIdentifiersAndDeviceInformationWhenYouVisitOur')}
            </li>
            <li>
              {t.raw('appLegalPage.line1613JsxTextGeolocationDataDependingOnYourDeviceAndApp')}
            </li>
            <li>{t.raw('appLegalPage.line1618JsxTextUsageDataWeLogYourActivityOnOur')}</li>
          </Bullets>
        </Clause>

        <Clause
          lead={t.raw('appLegalPage.line1631JsxTextSomeoneElseTellsUsInformationAboutYou')}
          intro={t.raw('appLegalPage.line1634JsxTextThirdPartySourcesIncludeForExample')}
        >
          <Bullets>
            <li>
              {t.raw(
                'appLegalPage.line1638JsxTextThirdPartyPartnersThirdPartyApplicationsAndServices',
              )}
            </li>
            <li>
              {t.raw(
                'appLegalPage.line1643JsxTextServiceProvidersThirdPartiesThatCollectOrProvide',
              )}
            </li>
          </Bullets>
        </Clause>

        <Clause lead={t.raw('appLegalPage.line1651JsxTextWhenWeTryAndUnderstandMoreAboutYou')}>
          <P>{t.raw('appLegalPage.line1655JsxTextWeInferNewInformationFromOtherDataWe')}</P>
        </Clause>
      </Section>

      <Section id="information-use" title={t.raw('appLegalPage.line1663JsxTextInformationUse')}>
        <P>{t.raw('appLegalPage.line1666JsxTextWeUseEachCategoryOfPersonalInformationAbout')}</P>
        <Bullets>
          <li>{t.raw('appLegalPage.line1669JsxTextToProvideYouWithOurServices')}</li>
          <li>{t.raw('appLegalPage.line1670JsxTextToImproveAndDevelopOurServices')}</li>
          <li>{t.raw('appLegalPage.line1671JsxTextToCommunicateWithYou')}</li>
          <li>{t.raw('appLegalPage.line1672JsxTextToProvideCustomerSupport')}</li>
        </Bullets>
      </Section>

      <Section
        id="information-sharing"
        title={t.raw('appLegalPage.line1676JsxTextInformationSharing')}
      >
        <P>{t.raw('appLegalPage.line1679JsxTextWeShareInformationAboutYou')}</P>
        <Bullets>
          <li>{t.raw('appLegalPage.line1683JsxTextWhenWeVeAskedReceivedYourConsentTo')}</li>
          <li>
            {t.raw('appLegalPage.line1686JsxTextAsNeededIncludingToThirdPartyServiceProviders')}
          </li>
          <li>{t.raw('appLegalPage.line1693JsxTextToComplyWithLawsOrToRespondTo')}</li>
          <li>{t.raw('appLegalPage.line1700JsxTextOnlyIfWeReasonablyBelieveItSNecessary')}</li>
          <li>{t.raw('appLegalPage.line1705JsxTextInTheEventOfACorporateRestructuringOr')}</li>
        </Bullets>
        <P>{t.raw('appLegalPage.line1712JsxTextPleaseNoteThatSomeOfOurServicesInclude')}</P>
        <P>{t.raw('appLegalPage.line1721JsxTextFinallyWeMayShareNonPersonalInformationIn')}</P>
      </Section>

      <Section
        id="information-protection"
        title={t.raw('appLegalPage.line1726JsxTextInformationProtection')}
      >
        <P>
          {t.raw(
            'appLegalPage.line1729JsxTextWeImplementPhysicalBusinessAndTechnicalSecurityMeasures',
          )}
        </P>
      </Section>

      <Section id="privacy-contact" title={t.raw('appLegalPage.line1739JsxTextContactUs')}>
        <P>
          {t.raw('appLegalPage.line1742JsxTextYouCanGetInTouchByEmailingUs')}{' '}
          <a href="mailto:info@kortix.com" className={LINK}>
            {t.raw('appLegalPage.line1747JsxTextInfoKortixCom')}
          </a>
          .
        </P>
      </Section>
    </div>
  );
}

function LegalContent() {
  const t = useTranslations('hardcodedUi');
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Terms moved to an external Drive folder (see lib/legal-terms-redirect.ts)
  // and is a link out of this page rather than a tab.
  const urlTab: LegalTab = isLegalTab(searchParams.get('tab'))
    ? (searchParams.get('tab') as LegalTab)
    : 'imprint';

  // Local state so a click paints immediately — `router.replace` is a soft
  // navigation and would otherwise gate the swap on an RSC round-trip. The URL
  // is reconciled *during render*, not in an effect: back/forward still switches
  // documents, without the render → effect → setState cascade.
  const [activeTab, setActiveTab] = useState<LegalTab>(urlTab);
  const [lastUrlTab, setLastUrlTab] = useState<LegalTab>(urlTab);
  if (lastUrlTab !== urlTab) {
    setLastUrlTab(urlTab);
    setActiveTab(urlTab);
  }

  const handleTabChange = (tab: LegalTab) => {
    setActiveTab(tab);
    const params = new URLSearchParams(searchParams);
    params.set('tab', tab);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const tabs: { id: LegalTab; label: string }[] = [
    { id: 'imprint', label: 'Imprint' },
    { id: 'privacy', label: t.raw('appLegalPage.line79JsxTextPrivacyPolicy') },
  ];

  return (
    <main className="bg-background min-h-screen">
      {/* Same container and header rhythm as /changelog and /blog: max-w-6xl,
          px-6, and top padding that clears the fixed navbar in (seo)/layout. */}
      <div className="mx-auto max-w-6xl px-6 pb-24 sm:pb-32">
        <header className="pt-28 pb-12 sm:pt-36 sm:pb-16">
          <h1 className="text-3xl font-medium text-balance md:text-4xl lg:tracking-tight">
            {t.raw('appLegalPage.line48JsxTextLegalInformation')}
          </h1>
          <p className="text-muted-foreground mt-5 max-w-xl text-base leading-relaxed text-pretty">
            {t.raw('appLegalPage.line93JsxTextInformationAccordingToLegalRequirements')}
            {' — '}
            company details, how we handle your data, and the terms that govern Kortix.
          </p>
        </header>

        <Separator />

        <div className={DOC_GRID}>
          {/* Same rail component /support uses — horizontal scroller below
              `lg`, sticky vertical list above it. Here the entries switch
              documents; on /support they are in-page anchors. */}
          <DocRail label="Legal documents">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => handleTabChange(tab.id)}
                aria-current={activeTab === tab.id ? 'true' : undefined}
                aria-controls="legal-document"
                className={docRailItem(activeTab === tab.id, 'cursor-pointer')}
              >
                {tab.label}
              </button>
            ))}

            {/* /legal/terms 308s to the Drive-hosted PDF from middleware. */}
            <Link href="/legal/terms" className={docRailItem()}>
              Terms of Service
              <ArrowUpRightIcon className="size-3.5 shrink-0 opacity-60" />
            </Link>
          </DocRail>

          {/* Keyed so switching documents replays the enter animation. */}
          <m.article
            key={activeTab}
            id="legal-document"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
            className={DOC_BODY}
          >
            <div className="mb-8">
              <h2 className="text-foreground text-2xl font-medium tracking-tight text-balance">
                {activeTab === 'imprint'
                  ? 'Imprint'
                  : t.raw('appLegalPage.line1531JsxTextPrivacyPolicy')}
              </h2>
              {activeTab === 'privacy' ? (
                <p className="text-muted-foreground mt-2 text-sm tabular-nums">
                  {t.raw('appLegalPage.line1534JsxTextLastUpdated')} {LEGAL_LAST_UPDATED}
                </p>
              ) : null}
            </div>

            {activeTab === 'imprint' ? <Imprint /> : <PrivacyPolicy />}
          </m.article>
        </div>
      </div>
    </main>
  );
}

/**
 * The fallback mirrors the real header box so the page does not jump when
 * `useSearchParams()` resolves.
 */
export default function LegalPage() {
  return (
    <Suspense
      fallback={
        <main className="bg-background min-h-screen">
          <div className="mx-auto max-w-6xl px-6">
            <header className="pt-28 pb-12 sm:pt-36 sm:pb-16">
              <h1 className="text-3xl font-medium text-balance md:text-4xl lg:tracking-tight">
                Legal Information
              </h1>
            </header>
          </div>
        </main>
      }
    >
      <LegalContent />
    </Suspense>
  );
}
