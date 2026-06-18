'use client';

import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import { ChevronDown } from 'lucide-react';
import { useState, useEffect, useRef, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Reveal } from '@/components/home/reveal';

function FAQItem({ question, answer }: { question: string; answer: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="border-b border-border last:border-0">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full text-left py-5 flex items-center justify-between gap-4 cursor-pointer"
      >
        <span className="text-base text-foreground">{question}</span>
        <ChevronDown
          className={cn('size-4 text-muted-foreground shrink-0 transition-transform duration-200', 
            isOpen ? 'rotate-180' : ''
          )}
        />
      </button>
      {isOpen && (
        <div className="pb-5">
          <div className="text-sm text-muted-foreground leading-relaxed">{answer}</div>
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
      setTimeout(() => {
        accountDeleteRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    }
  }, [searchParams]);

  const linkClass = 'text-foreground hover:text-foreground underline underline-offset-4 decoration-foreground/20 hover:decoration-foreground/50 transition-colors';

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-6 pt-24 sm:pt-32 pb-24 sm:pb-32">

        {/* Hero */}
        <Reveal>
          <h1 className="text-3xl sm:text-4xl md:text-5xl font-medium tracking-tight text-foreground mb-3">
            Support
          </h1>
        </Reveal>
        <Reveal delay={0.08}>
          <p className="text-base text-muted-foreground leading-relaxed max-w-xl">{tHardcodedUi.raw('appHomeSupportPage.line62JsxTextEmailUsAt')}{' '}
            <a href="mailto:support@kortix.com" className={linkClass}>{tHardcodedUi.raw('appHomeSupportPage.line63JsxTextSupportKortixCom')}</a>.
            {' '}{tHardcodedUi.raw('appHomeSupportPage.line64JsxTextWeTypicallyRespondWithin24HoursOnBusiness')}</p>
        </Reveal>

        {/* FAQ */}
        <Reveal>
          <div className="mt-14">
            <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-5">{tHardcodedUi.raw('appHomeSupportPage.line72JsxTextFrequentlyAskedQuestions')}</h2>
            <div>
              <FAQItem
                question={tHardcodedUi.raw('appHomeSupportPage.line76JsxAttrQuestionWhatIsKortix')}
                answer={tHardcodedUi.raw('appHomeSupportPage.line77JsxAttrAnswerA247CloudComputerWhereAiAgents')}
              />
              <FAQItem
                question={tHardcodedUi.raw('appHomeSupportPage.line80JsxAttrQuestionHowIsKortixDifferentFromOtherAiPlatforms')}
                answer={tHardcodedUi.raw('appHomeSupportPage.line81JsxAttrAnswerMostAiPlatformsAreChatInterfacesThatGive')}
              />
              <FAQItem
                question={tHardcodedUi.raw('appHomeSupportPage.line84JsxAttrQuestionCanKortixConnectToMyApps')}
                answer={tHardcodedUi.raw('appHomeSupportPage.line85JsxAttrAnswerYes3000IntegrationsViaOauthMcpServers')}
              />
              <FAQItem
                question={tHardcodedUi.raw('appHomeSupportPage.line88JsxAttrQuestionHowDoIRequestAFeatureOrReport')}
                answer={
                  <>Email <a href="mailto:support@kortix.com" className={linkClass}>{tHardcodedUi.raw('appHomeSupportPage.line90JsxTextSupportKortixCom')}</a>{tHardcodedUi.raw('appHomeSupportPage.line90JsxTextWithDetailsForBugsIncludeStepsToReproduce')}</>
                }
              />
              <FAQItem
                question={tHardcodedUi.raw('appHomeSupportPage.line94JsxAttrQuestionWhatIfIDonTGetCreditsAfter')}
                answer={
                  <>Contact <a href="mailto:support@kortix.com" className={linkClass}>{tHardcodedUi.raw('appHomeSupportPage.line96JsxTextSupportKortixCom')}</a>{tHardcodedUi.raw('appHomeSupportPage.line96JsxTextImmediatelyWePrioritizeBillingIssuesAndTypicallyResolve')}</>
                }
              />
            </div>
          </div>
        </Reveal>

        {/* Account Deletion */}
        <Reveal>
          <div ref={accountDeleteRef} id="account-delete" className="mt-14">
            <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-5">{tHardcodedUi.raw('appHomeSupportPage.line107JsxTextAccountDeletion')}</h2>
            <p className="text-base text-muted-foreground leading-relaxed mb-4">{tHardcodedUi.raw('appHomeSupportPage.line110JsxTextToDeleteYourAccountEitherEmail')}{' '}
              <a href="mailto:support@kortix.com" className={linkClass}>{tHardcodedUi.raw('appHomeSupportPage.line111JsxTextSupportKortixCom')}</a>
              {' '}{tHardcodedUi.raw('appHomeSupportPage.line112JsxTextOrDoItYourselfFromSettings')}</p>
            <ol className="text-sm text-muted-foreground leading-relaxed space-y-2 list-decimal ml-4">
              <li>{tHardcodedUi.raw('appHomeSupportPage.line115JsxTextClickYourAvatarSettings')}</li>
              <li>{tHardcodedUi.raw('appHomeSupportPage.line116JsxTextScrollToDeleteAccount')}</li>
              <li>{tHardcodedUi.raw('appHomeSupportPage.line117JsxTextChoose14DayGracePeriodOrImmediateDeletion')}</li>
              <li>{tHardcodedUi.raw('appHomeSupportPage.line118JsxTextTypeQuotDeleteQuotToConfirm')}</li>
            </ol>
            <p className="text-xs text-muted-foreground mt-4">{tHardcodedUi.raw('appHomeSupportPage.line121JsxTextAllAgentsSessionsCredentialsAndBillingDataWill')}</p>
          </div>
        </Reveal>

        {/* Legal */}
        <Reveal>
          <div className="mt-14">
            <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-5">
              Legal
            </h2>
            <div className="flex flex-col gap-1.5">
              <Link href="/legal?tab=terms" className={`text-base ${linkClass} w-fit`}>{tHardcodedUi.raw('appHomeSupportPage.line134JsxTextTermsOfService')}</Link>
              <Link href="/legal?tab=privacy" className={`text-base ${linkClass} w-fit`}>{tHardcodedUi.raw('appHomeSupportPage.line137JsxTextPrivacyPolicy')}</Link>
              <Link href="/legal?tab=imprint" className={`text-base ${linkClass} w-fit`}>
                Imprint
              </Link>
            </div>
          </div>
        </Reveal>

        {/* Contact */}
        <Reveal>
          <div className="mt-14 pt-8 border-t border-border">
            <p className="text-base text-muted-foreground leading-relaxed">{tHardcodedUi.raw('appHomeSupportPage.line150JsxTextStillNeedHelpReachOut')}</p>
            <div className="flex flex-col gap-1.5 mt-3">
              <a href="mailto:support@kortix.com" className={`text-base ${linkClass} w-fit`}>{tHardcodedUi.raw('appHomeSupportPage.line154JsxTextSupportKortixCom')}</a>
              <a href="mailto:security@kortix.com" className={`text-base ${linkClass} w-fit`}>{tHardcodedUi.raw('appHomeSupportPage.line157JsxTextSecurityKortixCom')}</a>
            </div>
          </div>
        </Reveal>

      </div>
    </main>
  );
}

export default function SupportPage() {
  return (
    <Suspense fallback={
      <main className="min-h-screen bg-background">
        <div className="max-w-3xl mx-auto px-6 pt-24 sm:pt-32">
          <div className="text-sm text-muted-foreground">Loading...</div>
        </div>
      </main>
    }>
      <SupportPageContent />
    </Suspense>
  );
}
