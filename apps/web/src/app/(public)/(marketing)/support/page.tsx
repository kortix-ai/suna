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
  ChannelCard,
  LINK,
  Note,
  P,
  PROSE,
  Section,
  SUPPORT_CONTAINER,
  SupportDocGrid,
  SupportHeader,
} from '@/features/marketing/support/support-doc';
import { cn } from '@/lib/utils';
import {
  BookOpenIcon,
  DiscordLogoIcon,
  EnvelopeIcon,
  PulseIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, type ReactNode } from 'react';

const SUPPORT_EMAIL = 'support@kortix.com';
const SECURITY_EMAIL = 'security@kortix.com';
const DISCORD_URL = 'https://discord.com/invite/RvFhXUdZ9H';
const STATUS_URL = 'https://status.kortix.com';

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
  const t = useTranslations('support.hub');
  const searchParams = useSearchParams();

  const sections = useMemo(
    () => [
      { id: 'faq', label: t('faqTitle') },
      { id: 'account-delete', label: t('accountTitle') },
      { id: 'legal', label: t('legalTitle') },
      { id: 'contact', label: t('contactTitle') },
    ],
    [t],
  );

  /**
   * Legacy `?section=<id>` deep link.
   *
   * Every section is anchor-addressable (`#account-delete`), so this query form
   * is redundant for anything written today — but `?section=account-delete` was
   * the URL that answered the App Store "how does a user delete their account"
   * requirement, and a saved link breaking there is expensive and silent.
   * Generalised to any section id so the next one is free.
   */
  useEffect(() => {
    const requested = searchParams.get('section');
    if (!requested) return;
    if (!sections.some((section) => section.id === requested)) return;
    const timer = setTimeout(() => {
      // `scroll-mt-28` on the section is honoured here, so the heading lands
      // below the fixed navbar rather than underneath it.
      document.getElementById(requested)?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
    return () => clearTimeout(timer);
  }, [searchParams, sections]);

  return (
    <main className="bg-background min-h-screen">
      {/* Container and header rhythm match /legal, /changelog and /blog: the
          navbar in (public)/layout is fixed, so the page reserves its own
          top space. */}
      <div className={cn(SUPPORT_CONTAINER, 'pb-24 sm:pb-32')}>
        <SupportHeader title={t('title')} lead={t('lead')}>
          {/* Four doors, above the fold. The page this replaced offered one
              mailto inside a paragraph. */}
          <div className="mt-9 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <ChannelCard
              icon={EnvelopeIcon}
              title={t('channelEmailTitle')}
              detail={SUPPORT_EMAIL}
              note={t('channelEmailNote')}
              href={`mailto:${SUPPORT_EMAIL}`}
            />
            <ChannelCard
              icon={DiscordLogoIcon}
              title={t('channelDiscordTitle')}
              detail={t('channelDiscordDetail')}
              note={t('channelDiscordNote')}
              href={DISCORD_URL}
              external
            />
            <ChannelCard
              icon={BookOpenIcon}
              title={t('channelDocsTitle')}
              detail={t('channelDocsDetail')}
              note={t('channelDocsNote')}
              href="/docs"
            />
            <ChannelCard
              icon={PulseIcon}
              title={t('channelStatusTitle')}
              detail="status.kortix.com"
              note={t('channelStatusNote')}
              href={STATUS_URL}
              external
            />
          </div>
        </SupportHeader>

        <Separator />

        <SupportDocGrid sections={sections}>
          {/* Operational questions first, product questions after. Someone on
              the support page is far more likely to be mid-problem than
              mid-evaluation. */}
          <Section id="faq" title={t('faqTitle')}>
            <Accordion
              type="single"
              collapsible
              className="-mx-4 flex w-full flex-col gap-1 border-0"
            >
              <Faq
                value="feature-or-bug"
                question={t('faqBugQuestion')}
                answer={
                  <>
                    {t('faqBugAnswerBefore')}{' '}
                    <a href={`mailto:${SUPPORT_EMAIL}`} className={LINK}>
                      {SUPPORT_EMAIL}
                    </a>
                    {t('faqBugAnswerAfter')}
                  </>
                }
              />
              <Faq
                value="missing-credits"
                question={t('faqCreditsQuestion')}
                answer={
                  <>
                    {t('faqCreditsAnswerBefore')}{' '}
                    <a href={`mailto:${SUPPORT_EMAIL}`} className={LINK}>
                      {SUPPORT_EMAIL}
                    </a>
                    {t('faqCreditsAnswerAfter')}
                  </>
                }
              />
              <Faq
                value="what-are-credits"
                question={t('faqWhatCreditsQuestion')}
                answer={
                  <>
                    {t('faqWhatCreditsAnswerBefore')}{' '}
                    <Link href="/docs/credits" className={LINK}>
                      {t('faqWhatCreditsLink')}
                    </Link>
                    {t('faqWhatCreditsAnswerAfter')}
                  </>
                }
              />
              <Faq
                value="connect-apps"
                question={t('faqConnectQuestion')}
                answer={t('faqConnectAnswer')}
              />
              <Faq
                value="what-is-kortix"
                question={t('faqWhatQuestion')}
                answer={t('faqWhatAnswer')}
              />
              <Faq
                value="how-different"
                question={t('faqDifferentQuestion')}
                answer={t('faqDifferentAnswer')}
              />
            </Accordion>
          </Section>

          <Section id="account-delete" title={t('accountTitle')}>
            <div className="space-y-4">
              <P>
                {t('accountLeadBefore')}{' '}
                <a href={`mailto:${SUPPORT_EMAIL}`} className={LINK}>
                  {SUPPORT_EMAIL}
                </a>{' '}
                {t('accountLeadAfter')}
              </P>
              <ol
                className={cn(PROSE, 'marker:text-muted-foreground/60 list-decimal space-y-2 pl-5')}
              >
                <li>{t('accountStep1')}</li>
                <li>{t('accountStep2')}</li>
                <li>{t('accountStep3')}</li>
                <li>{t('accountStep4')}</li>
              </ol>
              <Note>{t('accountWarning')}</Note>
            </div>
          </Section>

          <Section id="legal" title={t('legalTitle')}>
            <ul className="space-y-2">
              <li>
                <Link href="/legal/terms" className={cn(LINK, 'text-[15px]')}>
                  {t('legalTerms')}
                </Link>
              </li>
              <li>
                <Link href="/legal?tab=privacy" className={cn(LINK, 'text-[15px]')}>
                  {t('legalPrivacy')}
                </Link>
              </li>
              <li>
                <Link href="/legal?tab=imprint" className={cn(LINK, 'text-[15px]')}>
                  {t('legalImprint')}
                </Link>
              </li>
            </ul>
          </Section>

          <Section id="contact" title={t('contactTitle')}>
            <div className="space-y-4">
              <P>{t('contactLead')}</P>
              <dl className="divide-border divide-y border-y">
                <div className="grid gap-1 py-4 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-6">
                  <dt className="text-foreground text-sm font-medium tracking-tight">
                    {t('contactGeneral')}
                  </dt>
                  <dd>
                    <a href={`mailto:${SUPPORT_EMAIL}`} className={cn(LINK, 'text-[15px]')}>
                      {SUPPORT_EMAIL}
                    </a>
                  </dd>
                </div>
                <div className="grid gap-1 py-4 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-6">
                  <dt className="text-foreground text-sm font-medium tracking-tight">
                    {t('contactSecurity')}
                  </dt>
                  <dd>
                    <a href={`mailto:${SECURITY_EMAIL}`} className={cn(LINK, 'text-[15px]')}>
                      {SECURITY_EMAIL}
                    </a>
                  </dd>
                </div>
              </dl>
            </div>
          </Section>
        </SupportDocGrid>
      </div>
    </main>
  );
}

/**
 * The fallback mirrors the real header box so the page does not jump when
 * `useSearchParams()` resolves.
 */
function SupportPageFallback() {
  const t = useTranslations('support.hub');
  return (
    <main className="bg-background min-h-screen">
      <div className={SUPPORT_CONTAINER}>
        <SupportHeader title={t('title')} lead={t('lead')} />
      </div>
    </main>
  );
}

export default function SupportPage() {
  return (
    <Suspense fallback={<SupportPageFallback />}>
      <SupportPageContent />
    </Suspense>
  );
}
