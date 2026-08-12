'use client';

import { useTranslations } from 'next-intl';

import { Reveal } from '@/components/home/reveal';
import { cn } from '@/lib/utils';
import { CaretDownIcon as ChevronDown } from '@phosphor-icons/react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

function FAQItem({ question, answer }: { question: string; answer: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="border-border border-b last:border-0">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full cursor-pointer items-center justify-between gap-4 py-5 text-left"
      >
        <span className="text-foreground text-base">{question}</span>
        <ChevronDown
          className={cn(
            'text-muted-foreground size-4 shrink-0 transition-transform duration-200',
            isOpen ? 'rotate-180' : '',
          )}
        />
      </button>
      {isOpen && (
        <div className="pb-5">
          <div className="text-muted-foreground text-sm leading-relaxed">{answer}</div>
        </div>
      )}
    </div>
  );
}

function SupportPageContent() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const searchParams = useSearchParams();
  const accountDeleteRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const section = searchParams.get('section');
    if (section === 'account-delete' && accountDeleteRef.current) {
      const id = setTimeout(() => {
        accountDeleteRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
      return () => clearTimeout(id);
    }
  }, [searchParams]);

  const linkClass =
    'text-foreground hover:text-foreground underline underline-offset-4 decoration-foreground/20 hover:decoration-foreground/50 transition-colors';

  return (
    <main className="bg-background min-h-screen">
      <div className="mx-auto max-w-3xl px-6 pt-24 pb-24 sm:pt-32 sm:pb-32">
        {/* Hero */}
        <Reveal>
          <h1 className="text-foreground mb-3 text-3xl font-medium tracking-tight sm:text-4xl md:text-5xl">
            Support
          </h1>
        </Reveal>
        <Reveal delay={0.08}>
          <p className="text-muted-foreground max-w-xl text-base leading-relaxed">
            {tHardcodedUi.raw('appHomeSupportPage.line62JsxTextEmailUsAt')}{' '}
            <a href="mailto:support@dosco.live" className={linkClass}>
              {tHardcodedUi.raw('appHomeSupportPage.line63JsxTextSupportdoscoCom')}
            </a>
            .{' '}
            {tHardcodedUi.raw(
              'appHomeSupportPage.line64JsxTextWeTypicallyRespondWithin24HoursOnBusiness',
            )}
          </p>
        </Reveal>

        {/* FAQ */}
        <Reveal>
          <div className="mt-14">
            <h2 className="text-muted-foreground mb-5 text-xs tracking-widest uppercase">
              {tHardcodedUi.raw('appHomeSupportPage.line72JsxTextFrequentlyAskedQuestions')}
            </h2>
            <div>
              <FAQItem
                question={tHardcodedUi.raw('appHomeSupportPage.line76JsxAttrQuestionWhatIsdosco')}
                answer={tHardcodedUi.raw(
                  'appHomeSupportPage.line77JsxAttrAnswerA247CloudComputerWhereAiAgents',
                )}
              />
              <FAQItem
                question={tHardcodedUi.raw(
                  'appHomeSupportPage.line80JsxAttrQuestionHowIsdoscoDifferentFromOtherAiPlatforms',
                )}
                answer={tHardcodedUi.raw(
                  'appHomeSupportPage.line81JsxAttrAnswerMostAiPlatformsAreChatInterfacesThatGive',
                )}
              />
              <FAQItem
                question={tHardcodedUi.raw(
                  'appHomeSupportPage.line84JsxAttrQuestionCandoscoConnectToMyApps',
                )}
                answer={tHardcodedUi.raw(
                  'appHomeSupportPage.line85JsxAttrAnswerYes3000ConnectorsViaOauthMcpServers',
                )}
              />
              <FAQItem
                question={tHardcodedUi.raw(
                  'appHomeSupportPage.line88JsxAttrQuestionHowDoIRequestAFeatureOrReport',
                )}
                answer={
                  <>
                    Email{' '}
                    <a href="mailto:support@dosco.live" className={linkClass}>
                      {tHardcodedUi.raw('appHomeSupportPage.line90JsxTextSupportdoscoCom')}
                    </a>
                    {tHardcodedUi.raw(
                      'appHomeSupportPage.line90JsxTextWithDetailsForBugsIncludeStepsToReproduce',
                    )}
                  </>
                }
              />
              <FAQItem
                question={tHardcodedUi.raw(
                  'appHomeSupportPage.line94JsxAttrQuestionWhatIfIDonTGetCreditsAfter',
                )}
                answer={
                  <>
                    Contact{' '}
                    <a href="mailto:support@dosco.live" className={linkClass}>
                      {tHardcodedUi.raw('appHomeSupportPage.line96JsxTextSupportdoscoCom')}
                    </a>
                    {tHardcodedUi.raw(
                      'appHomeSupportPage.line96JsxTextImmediatelyWePrioritizeBillingIssuesAndTypicallyResolve',
                    )}
                  </>
                }
              />
            </div>
          </div>
        </Reveal>

        {/* Account Deletion */}
        <Reveal>
          <div ref={accountDeleteRef} id="account-delete" className="mt-14">
            <h2 className="text-muted-foreground mb-5 text-xs tracking-widest uppercase">
              {tHardcodedUi.raw('appHomeSupportPage.line107JsxTextAccountDeletion')}
            </h2>
            <p className="text-muted-foreground mb-4 text-base leading-relaxed">
              {tHardcodedUi.raw('appHomeSupportPage.line110JsxTextToDeleteYourAccountEitherEmail')}{' '}
              <a href="mailto:support@dosco.live" className={linkClass}>
                {tHardcodedUi.raw('appHomeSupportPage.line111JsxTextSupportdoscoCom')}
              </a>{' '}
              {tHardcodedUi.raw('appHomeSupportPage.line112JsxTextOrDoItYourselfFromSettings')}
            </p>
            <ol className="text-muted-foreground ml-4 list-decimal space-y-2 text-sm leading-relaxed">
              <li>
                {tHardcodedUi.raw('appHomeSupportPage.line115JsxTextClickYourAvatarSettings')}
              </li>
              <li>{tHardcodedUi.raw('appHomeSupportPage.line116JsxTextScrollToDeleteAccount')}</li>
              <li>
                {tHardcodedUi.raw(
                  'appHomeSupportPage.line117JsxTextChoose14DayGracePeriodOrImmediateDeletion',
                )}
              </li>
              <li>
                {tHardcodedUi.raw('appHomeSupportPage.line118JsxTextTypeQuotDeleteQuotToConfirm')}
              </li>
            </ol>
            <p className="text-muted-foreground mt-4 text-xs">
              {tHardcodedUi.raw(
                'appHomeSupportPage.line121JsxTextAllAgentsSessionsCredentialsAndBillingDataWill',
              )}
            </p>
          </div>
        </Reveal>

        {/* Legal */}
        <Reveal>
          <div className="mt-14">
            <h2 className="text-muted-foreground mb-5 text-xs tracking-widest uppercase">Legal</h2>
            <div className="flex flex-col gap-1.5">
              <Link href="/legal/terms" prefetch={false} className={`text-base ${linkClass} w-fit`}>
                {tHardcodedUi.raw('appHomeSupportPage.line134JsxTextTermsOfService')}
              </Link>
              <Link href="/legal?tab=privacy" className={`text-base ${linkClass} w-fit`}>
                {tHardcodedUi.raw('appHomeSupportPage.line137JsxTextPrivacyPolicy')}
              </Link>
              <Link href="/legal?tab=imprint" className={`text-base ${linkClass} w-fit`}>
                Imprint
              </Link>
            </div>
          </div>
        </Reveal>

        {/* Contact */}
        <Reveal>
          <div className="border-border mt-14 border-t pt-8">
            <p className="text-muted-foreground text-base leading-relaxed">
              {tHardcodedUi.raw('appHomeSupportPage.line150JsxTextStillNeedHelpReachOut')}
            </p>
            <div className="mt-3 flex flex-col gap-1.5">
              <a href="mailto:support@dosco.live" className={`text-base ${linkClass} w-fit`}>
                {tHardcodedUi.raw('appHomeSupportPage.line154JsxTextSupportdoscoCom')}
              </a>
              <a href="mailto:security@dosco.live" className={`text-base ${linkClass} w-fit`}>
                {tHardcodedUi.raw('appHomeSupportPage.line157JsxTextSecuritydoscoCom')}
              </a>
            </div>
          </div>
        </Reveal>
      </div>
    </main>
  );
}

export default function SupportPage() {
  return (
    <Suspense
      fallback={
        <main className="bg-background min-h-screen">
          <div className="mx-auto max-w-3xl px-6 pt-24 sm:pt-32">
            <div className="text-muted-foreground text-sm">Loading...</div>
          </div>
        </main>
      }
    >
      <SupportPageContent />
    </Suspense>
  );
}
