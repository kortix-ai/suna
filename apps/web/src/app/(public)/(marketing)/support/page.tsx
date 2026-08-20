'use client';

import { useTranslations } from 'next-intl';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Separator } from '@/components/ui/separator';
import {
  DOC_BODY,
  DOC_GRID,
  DocRail,
  docRailItem,
  useActiveSection,
} from '@/features/marketing/doc-rail';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, type ReactNode } from 'react';

const LINK =
  'text-foreground decoration-foreground/25 hover:decoration-foreground/60 wrap-break-word underline underline-offset-4 transition-colors';

// Same container the header and the document grid share, so nothing drifts.
const CONTAINER = 'mx-auto max-w-6xl px-6';

const PROSE = 'text-muted-foreground text-[15px] leading-7 text-pretty';

/** Ids are the anchor targets the rail links to and the scroll-spy watches. */
const SECTION_IDS = ['faq', 'account-delete', 'legal', 'contact'] as const;

/** A titled block of the document. `scroll-mt-28` clears the fixed navbar. */
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-28">
      <h2 className="text-foreground text-lg font-medium tracking-tight text-balance">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * One FAQ row, keeping the Accordion chrome from the marketing `FaqSection`:
 * soft hover/open card fill, no hairline borders, padded trigger and answer.
 *
 * The `-mx-4` on the Accordion cancels this `px-4`, so question text lines up
 * with the section heading while the card fill still extends past it.
 */
function Faq({ value, question, answer }: { value: string; question: string; answer: ReactNode }) {
  return (
    <AccordionItem
      value={value}
      className="hover:bg-card data-[state=open]:bg-card rounded-lg border-0 transition-colors"
    >
      <AccordionTrigger className="rounded-lg px-4 py-5 text-left hover:no-underline">
        <span className="text-foreground min-w-0 text-[15px] leading-snug font-medium tracking-tight text-balance">
          {question}
        </span>
      </AccordionTrigger>
      <AccordionContent className="px-4 pb-6">
        <p className={cn(PROSE, 'min-w-0')}>{answer}</p>
      </AccordionContent>
    </AccordionItem>
  );
}

function SupportPageContent() {
  const t = useTranslations('hardcodedUi');
  const searchParams = useSearchParams();
  const activeSection = useActiveSection(SECTION_IDS);

  const sections: { id: string; label: string }[] = [
    { id: 'faq', label: t.raw('appHomeSupportPage.line72JsxTextFrequentlyAskedQuestions') },
    { id: 'account-delete', label: t.raw('appHomeSupportPage.line107JsxTextAccountDeletion') },
    { id: 'legal', label: 'Legal' },
    { id: 'contact', label: 'Contact' },
  ];

  useEffect(() => {
    if (searchParams.get('section') !== 'account-delete') return;
    const timer = setTimeout(() => {
      // `scroll-mt-28` on the section is honoured here, so the heading lands
      // below the fixed navbar rather than underneath it.
      document.getElementById('account-delete')?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
    return () => clearTimeout(timer);
  }, [searchParams]);

  return (
    <main className="bg-background min-h-screen">
      {/* Container and header rhythm match /legal, /changelog and /blog: the
          navbar in (public)/layout is fixed, so the page reserves its own
          top space. */}
      <div className={cn(CONTAINER, 'pb-24 sm:pb-32')}>
        <header className="pt-28 pb-12 sm:pt-36 sm:pb-16">
          <h1 className="text-3xl font-medium text-balance md:text-4xl lg:tracking-tight">
            Support
          </h1>
          <p className="text-muted-foreground mt-5 max-w-xl text-base leading-relaxed text-pretty">
            {t.raw('appHomeSupportPage.line62JsxTextEmailUsAt')}{' '}
            <a href="mailto:support@kortix.com" className={LINK}>
              {t.raw('appHomeSupportPage.line63JsxTextSupportKortixCom')}
            </a>
            . {t.raw('appHomeSupportPage.line64JsxTextWeTypicallyRespondWithin24HoursOnBusiness')}
          </p>
        </header>

        <Separator />

        <div className={DOC_GRID}>
          <DocRail label="On this page">
            {sections.map((section) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                aria-current={activeSection === section.id ? 'true' : undefined}
                className={docRailItem(activeSection === section.id)}
              >
                {section.label}
              </a>
            ))}
          </DocRail>

          <div className={cn(DOC_BODY, 'space-y-12')}>
            <Section
              id="faq"
              title={t.raw('appHomeSupportPage.line72JsxTextFrequentlyAskedQuestions')}
            >
              <Accordion
                type="single"
                collapsible
                className="-mx-4 flex w-full flex-col gap-1 border-0"
              >
                <Faq
                  value="what-is-kortix"
                  question={t.raw('appHomeSupportPage.line76JsxAttrQuestionWhatIsKortix')}
                  answer={t.raw(
                    'appHomeSupportPage.line77JsxAttrAnswerA247CloudComputerWhereAiAgents',
                  )}
                />
                <Faq
                  value="how-different"
                  question={t.raw(
                    'appHomeSupportPage.line80JsxAttrQuestionHowIsKortixDifferentFromOtherAiPlatforms',
                  )}
                  answer={t.raw(
                    'appHomeSupportPage.line81JsxAttrAnswerMostAiPlatformsAreChatInterfacesThatGive',
                  )}
                />
                <Faq
                  value="connect-apps"
                  question={t.raw(
                    'appHomeSupportPage.line84JsxAttrQuestionCanKortixConnectToMyApps',
                  )}
                  answer={t.raw(
                    'appHomeSupportPage.line85JsxAttrAnswerYes3000ConnectorsViaOauthMcpServers',
                  )}
                />
                <Faq
                  value="feature-or-bug"
                  question={t.raw(
                    'appHomeSupportPage.line88JsxAttrQuestionHowDoIRequestAFeatureOrReport',
                  )}
                  answer={
                    <>
                      Email{' '}
                      <a href="mailto:support@kortix.com" className={LINK}>
                        {t.raw('appHomeSupportPage.line90JsxTextSupportKortixCom')}
                      </a>
                      {t.raw(
                        'appHomeSupportPage.line90JsxTextWithDetailsForBugsIncludeStepsToReproduce',
                      )}
                    </>
                  }
                />
                <Faq
                  value="missing-credits"
                  question={t.raw(
                    'appHomeSupportPage.line94JsxAttrQuestionWhatIfIDonTGetCreditsAfter',
                  )}
                  answer={
                    <>
                      Contact{' '}
                      <a href="mailto:support@kortix.com" className={LINK}>
                        {t.raw('appHomeSupportPage.line96JsxTextSupportKortixCom')}
                      </a>
                      {t.raw(
                        'appHomeSupportPage.line96JsxTextImmediatelyWePrioritizeBillingIssuesAndTypicallyResolve',
                      )}
                    </>
                  }
                />
              </Accordion>
            </Section>

            <Section
              id="account-delete"
              title={t.raw('appHomeSupportPage.line107JsxTextAccountDeletion')}
            >
              <div className="space-y-4">
                <p className={PROSE}>
                  {t.raw('appHomeSupportPage.line110JsxTextToDeleteYourAccountEitherEmail')}{' '}
                  <a href="mailto:support@kortix.com" className={LINK}>
                    {t.raw('appHomeSupportPage.line111JsxTextSupportKortixCom')}
                  </a>{' '}
                  {t.raw('appHomeSupportPage.line112JsxTextOrDoItYourselfFromSettings')}
                </p>
                <ol
                  className={cn(
                    PROSE,
                    'marker:text-muted-foreground/60 list-decimal space-y-2 pl-5',
                  )}
                >
                  <li>{t.raw('appHomeSupportPage.line115JsxTextClickYourAvatarSettings')}</li>
                  <li>{t.raw('appHomeSupportPage.line116JsxTextScrollToDeleteAccount')}</li>
                  <li>
                    {t.raw(
                      'appHomeSupportPage.line117JsxTextChoose14DayGracePeriodOrImmediateDeletion',
                    )}
                  </li>
                  <li>{t.raw('appHomeSupportPage.line118JsxTextTypeQuotDeleteQuotToConfirm')}</li>
                </ol>
                <p className="text-muted-foreground/80 text-[13px] leading-6 text-pretty">
                  {t.raw(
                    'appHomeSupportPage.line121JsxTextAllAgentsSessionsCredentialsAndBillingDataWill',
                  )}
                </p>
              </div>
            </Section>

            <Section id="legal" title="Legal">
              <ul className="space-y-2">
                <li>
                  <Link href="/legal/terms" className={cn(LINK, 'text-[15px]')}>
                    {t.raw('appHomeSupportPage.line134JsxTextTermsOfService')}
                  </Link>
                </li>
                <li>
                  <Link href="/legal?tab=privacy" className={cn(LINK, 'text-[15px]')}>
                    {t.raw('appHomeSupportPage.line137JsxTextPrivacyPolicy')}
                  </Link>
                </li>
                <li>
                  <Link href="/legal?tab=imprint" className={cn(LINK, 'text-[15px]')}>
                    Imprint
                  </Link>
                </li>
              </ul>
            </Section>

            <Section id="contact" title="Contact">
              <div className="space-y-4">
                <p className={PROSE}>
                  {t.raw('appHomeSupportPage.line150JsxTextStillNeedHelpReachOut')}
                </p>
                <ul className="space-y-2">
                  <li>
                    <a href="mailto:support@kortix.com" className={cn(LINK, 'text-[15px]')}>
                      {t.raw('appHomeSupportPage.line154JsxTextSupportKortixCom')}
                    </a>
                  </li>
                  <li>
                    <a href="mailto:security@kortix.com" className={cn(LINK, 'text-[15px]')}>
                      {t.raw('appHomeSupportPage.line157JsxTextSecurityKortixCom')}
                    </a>
                  </li>
                </ul>
              </div>
            </Section>
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * The fallback mirrors the real header box so the page does not jump when
 * `useSearchParams()` resolves.
 */
export default function SupportPage() {
  return (
    <Suspense
      fallback={
        <main className="bg-background min-h-screen">
          <div className={CONTAINER}>
            <header className="pt-28 pb-12 sm:pt-36 sm:pb-16">
              <h1 className="text-3xl font-medium text-balance md:text-4xl lg:tracking-tight">
                Support
              </h1>
            </header>
          </div>
        </main>
      }
    >
      <SupportPageContent />
    </Suspense>
  );
}
