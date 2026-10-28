'use client';

import { useTranslations } from '@/i18n/use-translations';

import Link from '@/components/site-link';
import { UseCaseToc, type TocItem } from '@/components/use-cases/use-case-toc';
import { CopyRow } from '@/features/marketing/kit/copy-row';
import { Band, PageFrame, PageHero } from '@/features/marketing/kit/page-frame';
import { cn } from '@kortix/ui';
import { usePathname, useSearchParams } from 'next/navigation';
import { Fragment, Suspense, useState, type ReactNode } from 'react';

import { ENTERPRISE_TERMS, ENTERPRISE_TERMS_LAST_UPDATED } from './enterprise-terms';
import { TERMS_LAST_UPDATED, TERMS_OF_SERVICE } from './terms-of-service';

const LEGAL_LAST_UPDATED = 'September 29, 2026';

type LegalTab = 'imprint' | 'terms' | 'privacy' | 'enterprise';

function isLegalTab(value: string | null): value is LegalTab {
  return value === 'imprint' || value === 'terms' || value === 'privacy' || value === 'enterprise';
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
const PROSE = 'text-muted-foreground text-base leading-7 text-pretty';

// Hover takes the ring colour, like the contact rows (`kit/copy-row.tsx`).
const LINK =
  'text-foreground decoration-foreground/25 hover:text-ring hover:decoration-ring/60 wrap-break-word underline underline-offset-4 transition-colors duration-normal ease-out';

// ---------------------------------------------------------------------------
// Prose atoms
// ---------------------------------------------------------------------------

/** A titled block of a legal document. `scroll-mt-24` clears the fixed navbar. */
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24">
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
    <ul className={cn(PROSE, 'marker:text-muted-foreground list-disc space-y-2 pl-5')}>
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
      <p className="text-foreground text-base leading-7 font-medium text-pretty">{lead}</p>
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

      <Section id="imprint-contact" title={t.raw('i18nComplete.text2b5c3d26721a')}>
        {/* The same click-to-copy rows as /contact; they carry the address
            the sentence used to repeat. */}
        <ul className="divide-y border-y">
          <li>
            <CopyRow label="General" value="info@kortix.com" />
          </li>
          <li>
            <CopyRow label="Privacy" value={PRIVACY_EMAIL} />
          </li>
        </ul>
      </Section>

      <Section
        id="responsible-for-content"
        title={t.raw('appLegalPage.line136JsxTextResponsibleForContent')}
      >
        <P>{t.raw('appLegalPage.line139JsxTextKortixAiCorpIsResponsibleForTheContent')}</P>
      </Section>

      <Section id="disclaimer" title={t.raw('i18nComplete.text129c678fce59')}>
        <P>{t.raw('appLegalPage.line147JsxTextTheInformationProvidedOnThisWebsiteIsFor')}</P>
      </Section>
    </div>
  );
}

/**
 * The privacy policy is English only, like the Terms of Service: a legal text
 * has one authoritative version. It states GDPR Articles 13 and 14 facts that
 * the Data Processing Addendum and the retention summary also state; change
 * them together.
 */
const PRIVACY_EMAIL = 'privacy@kortix.com';

function MailLink({ address }: { address: string }) {
  return (
    <a href={`mailto:${address}`} className={LINK}>
      {address}
    </a>
  );
}

/** Section ids and titles of the privacy policy, shared with the contents rail. */
const PRIVACY_TITLES = {
  privacy: 'Who we are',
  'information-gathering': 'Information we collect',
  'information-use': 'How we use it and our legal bases',
  cookies: 'Cookies and analytics',
  'information-sharing': 'Who we share it with',
  'international-transfers': 'International transfers',
  retention: 'How long we keep it',
  'information-protection': 'How we protect it',
  'your-rights': 'Your rights',
  children: 'Children',
  changes: 'Changes to this policy',
  'privacy-contact': 'Contact',
} as const;

function PrivacyPolicy() {
  return (
    <div className="space-y-10">
      <Section id="privacy" title={PRIVACY_TITLES['privacy']}>
        <P>
          Kortix AI Corp, a Delaware corporation at 701 Tillery Street Unit 12-2521, Austin, Texas
          78702, United States (&quot;Kortix&quot;, &quot;we&quot;), is the controller of the
          personal information described in this policy. It applies to our websites, apps, APIs, and
          the other services that link to it (the &quot;Services&quot;).
        </P>
        <P>
          Our Data Protection Officer is reachable at <MailLink address={PRIVACY_EMAIL} />.
        </P>
        <P>
          When a customer uses the Services to process personal information (for example, the files,
          prompts, and connected data in a customer workspace), the customer is the controller and
          Kortix processes that information on the customer&apos;s behalf under our Data Processing
          Addendum. If your information is in a customer&apos;s workspace, send requests about it to
          that customer.
        </P>
      </Section>

      <Section id="information-gathering" title={PRIVACY_TITLES['information-gathering']}>
        <Clause lead="Information you give us">
          <Bullets>
            <li>Account and contact details: name, email address, organization, and role.</li>
            <li>
              Billing details. Stripe processes card payments; we receive the billing contact, plan,
              and payment status, not full card numbers.
            </li>
            <li>
              Content: the prompts, files, messages, code, and other material you submit, and the
              outputs the Services generate.
            </li>
            <li>
              Connected accounts: the credentials and tokens you give us to connect other services.
              We store them encrypted and use them only to act on your instructions.
            </li>
            <li>Support and sales conversations.</li>
          </Bullets>
        </Clause>
        <Clause lead="Information we collect automatically">
          <Bullets>
            <li>
              Device and log data: IP address, browser, operating system, device identifiers, and
              request logs.
            </li>
            <li>Approximate location, derived from your IP address.</li>
            <li>Usage data: pages viewed, features used, and actions taken in the Services.</li>
            <li>Cookies and similar technologies, described below.</li>
          </Bullets>
        </Clause>
        <Clause lead="Information from others">
          <Bullets>
            <li>Sign-in providers you choose, such as Google or GitHub.</li>
            <li>Services you connect, which send us the data you ask the Services to use.</li>
            <li>Your organization, when it invites you to a workspace.</li>
          </Bullets>
        </Clause>
      </Section>

      <Section id="information-use" title={PRIVACY_TITLES['information-use']}>
        <Bullets>
          <li>
            To provide the Services, including running agents on your instructions, and to support
            you. Legal basis: performance of our contract with you.
          </li>
          <li>
            To secure the Services and to detect fraud and abuse. Legal basis: our legitimate
            interest in a safe service.
          </li>
          <li>
            To understand how the Services are used and to improve them. Legal basis: our legitimate
            interests, or your consent where cookie law requires it.
          </li>
          <li>
            To send service messages and, if you agree, product news. You can unsubscribe from
            marketing email at any time. Legal basis: contract for service messages; consent or
            legitimate interest for marketing.
          </li>
          <li>
            To bill you and to meet tax, accounting, and other legal duties. Legal basis: legal
            obligation.
          </li>
        </Bullets>
        <P>
          We do not use customer content or outputs to train general-purpose AI models unless the
          customer gives us express permission. We do not make decisions that have legal or
          similarly significant effects on you based solely on automated processing.
        </P>
      </Section>

      <Section id="cookies" title={PRIVACY_TITLES['cookies']}>
        <P>
          We use cookies that the Services need to work, such as the sign-in session. On our
          marketing website we also use analytics (PostHog, Vercel Analytics) and, through Google
          Tag Manager, advertising and measurement tags. A cookie banner asks for your consent
          before we set non-essential cookies where the law requires consent, and you can change
          your choice there at any time. We do not load advertising tags on signed-in pages of the
          Services.
        </P>
      </Section>

      <Section id="information-sharing" title={PRIVACY_TITLES['information-sharing']}>
        <Bullets>
          <li>
            Service providers that process data for us, listed on our{' '}
            <Link href="/legal/subprocessors" className={LINK}>
              subprocessors page
            </Link>
            .
          </li>
          <li>Third-party services you connect or instruct an agent to use, on your behalf.</li>
          <li>Our affiliates, which support and operate the Services.</li>
          <li>Authorities, when the law requires it or to protect people and the Services.</li>
          <li>
            A buyer or successor, if Kortix is part of a merger, acquisition, or reorganization.
          </li>
        </Bullets>
        <P>We do not sell personal information.</P>
      </Section>

      <Section id="international-transfers" title={PRIVACY_TITLES['international-transfers']}>
        <P>
          We host the Services mainly in the United Kingdom and the European Union. We and our
          service providers also process personal information in the United States and other
          countries. When we transfer personal information from the European Economic Area, the
          United Kingdom, or Switzerland to a country without an adequacy decision, we use the
          European Commission&apos;s Standard Contractual Clauses, with the UK Addendum and Swiss
          amendments where they apply.
        </P>
      </Section>

      <Section id="retention" title={PRIVACY_TITLES['retention']}>
        <Bullets>
          <li>Account information: while your account exists.</li>
          <li>
            Customer content: for the subscription, then deleted within 90 days after it ends,
            unless the customer asks for earlier deletion or the law requires us to keep it.
          </li>
          <li>Backups: removed on a rolling cycle of about 35 days.</li>
          <li>Application logs: up to 365 days.</li>
          <li>Billing records: as long as tax and accounting law requires.</li>
        </Bullets>
        <P>
          After an account deletion request, a 14-day grace period applies before deletion starts.
        </P>
      </Section>

      <Section id="information-protection" title={PRIVACY_TITLES['information-protection']}>
        <P>
          We encrypt data in transit with TLS and at rest, restrict access to people who need it,
          require multi-factor authentication for administrative access, run agents in isolated
          sandboxes, and monitor our systems for security events. No method of transmission or
          storage is completely secure.
        </P>
      </Section>

      <Section id="your-rights" title={PRIVACY_TITLES['your-rights']}>
        <P>
          Depending on where you live, you can ask to access, correct, delete, restrict, or receive
          a copy of your personal information, object to our processing, and withdraw consent at any
          time without affecting earlier processing. Email <MailLink address={PRIVACY_EMAIL} />. We
          answer within one month and may ask you to verify your identity.
        </P>
        <P>
          If you are in the EEA, the United Kingdom, or Switzerland, you can also complain to the
          data protection authority where you live or work. Residents of US states with privacy laws
          have the rights those laws give them, and we will not discriminate against you for using
          them.
        </P>
      </Section>

      <Section id="children" title={PRIVACY_TITLES['children']}>
        <P>
          The Services are not directed to children under 16, and we do not knowingly collect their
          personal information.
        </P>
      </Section>

      <Section id="changes" title={PRIVACY_TITLES['changes']}>
        <P>
          We post changes on this page and update the date above. We notify you by email or in the
          Services before a material change takes effect.
        </P>
      </Section>

      <Section id="privacy-contact" title={PRIVACY_TITLES['privacy-contact']}>
        <P>
          Privacy questions and requests, including for our Data Protection Officer:{' '}
          <MailLink address={PRIVACY_EMAIL} />. Post: Kortix AI Corp, Attn: Data Protection Officer,
          701 Tillery Street Unit 12-2521, Austin, Texas 78702, United States.
        </P>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Terms of Service — rendered from `terms-of-service.ts`
// ---------------------------------------------------------------------------

type TermsBlock = { kind: 'p'; text: string } | { kind: 'ul' | 'ol'; items: string[] };

type TermsSection = { id: string; title: string; blocks: TermsBlock[] };

/**
 * The Markdown the Terms use, and nothing more: `##` sections, paragraphs,
 * `-` bullets and `1.` lists. Items are separated by blank lines in the source,
 * so consecutive items of one kind are merged into one list.
 */
function parseTerms(source: string): { intro: TermsBlock[]; sections: TermsSection[] } {
  const intro: TermsBlock[] = [];
  const sections: TermsSection[] = [];
  for (const raw of source.split(/\n\s*\n/)) {
    const chunk = raw.trim();
    if (!chunk) continue;
    if (chunk.startsWith('## ')) {
      const title = chunk.slice(3).trim();
      const slug = title
        .replace(/^\d+\.\s*/, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      sections.push({ id: `terms-${slug}`, title, blocks: [] });
      continue;
    }
    const blocks = sections.at(-1)?.blocks ?? intro;
    const kind = /^-\s/.test(chunk) ? 'ul' : /^\d+\.\s/.test(chunk) ? 'ol' : 'p';
    if (kind === 'p') {
      blocks.push({ kind, text: chunk.replace(/\s*\n\s*/g, ' ') });
      continue;
    }
    const item = chunk.replace(/^(-|\d+\.)\s+/, '').replace(/\s*\n\s*/g, ' ');
    const last = blocks.at(-1);
    if (last && last.kind === kind) last.items.push(item);
    else blocks.push({ kind, items: [item] });
  }
  return { intro, sections };
}

const TERMS = parseTerms(TERMS_OF_SERVICE);
const ENTERPRISE = parseTerms(ENTERPRISE_TERMS);

/** `**Defined term**` reads in the foreground; an address is a mail link. */
function TermsInline({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*|[a-z]+@kortix\.com)/g).map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return (
            <strong key={index} className="text-foreground font-medium">
              {part.slice(2, -2)}
            </strong>
          );
        }
        if (/^[a-z]+@kortix\.com$/.test(part)) return <MailLink key={index} address={part} />;
        return <Fragment key={index}>{part}</Fragment>;
      })}
    </>
  );
}

function TermsBlocks({ blocks }: { blocks: TermsBlock[] }) {
  return blocks.map((block, index) =>
    block.kind === 'p' ? (
      <P key={index}>
        <TermsInline text={block.text} />
      </P>
    ) : block.kind === 'ul' ? (
      <Bullets key={index}>
        {block.items.map((item) => (
          <li key={item}>
            <TermsInline text={item} />
          </li>
        ))}
      </Bullets>
    ) : (
      <ol
        key={index}
        className={cn(PROSE, 'marker:text-muted-foreground list-decimal space-y-2 pl-6')}
      >
        {block.items.map((item) => (
          <li key={item}>
            <TermsInline text={item} />
          </li>
        ))}
      </ol>
    ),
  );
}

/** English only, like the privacy policy. The texts live in `terms-of-service.ts` and `enterprise-terms.ts`. */
function TermsDocument({ doc }: { doc: ReturnType<typeof parseTerms> }) {
  return (
    <div className="space-y-10">
      <div className="space-y-4">
        <TermsBlocks blocks={doc.intro} />
      </div>
      {doc.sections.map((section) => (
        <Section key={section.id} id={section.id} title={section.title}>
          <TermsBlocks blocks={section.blocks} />
        </Section>
      ))}
    </div>
  );
}

/** Rail links: the active document, the others muted (Buio's legal nav). */
function railItem(active: boolean) {
  return cn(
    'outline-ring flex min-h-11 shrink-0 items-center text-left text-sm whitespace-nowrap focus-visible:outline-2',
    'duration-moderate transition-colors lg:min-h-9 lg:whitespace-normal',
    active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
  );
}

/** The landing hero's header, shared with the Suspense fallback so nothing jumps. */
function LegalHeading() {
  return (
    <PageHero
      title="Legal information."
      titleMuted="Imprint, terms and privacy."
      sub="Company details, how we handle your data, and the terms that govern Kortix."
    />
  );
}

function LegalContent() {
  const t = useTranslations('hardcodedUi');
  const searchParams = useSearchParams();
  const pathname = usePathname();

  // `/legal/terms` redirects here with `?tab=terms` (lib/legal-terms-redirect.ts).
  const urlTab: LegalTab = isLegalTab(searchParams.get('tab'))
    ? (searchParams.get('tab') as LegalTab)
    : 'imprint';

  // Local state so a click paints immediately — a router navigation would
  // otherwise gate the swap on an RSC round-trip. The URL is reconciled *during
  // render*, not in an effect: back/forward still switches documents, without
  // the render → effect → setState cascade.
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
    // The tab is painted from local state and the page owns no server data per
    // tab, so the URL only has to record the choice. Next patches
    // `replaceState` and updates its own canonical URL, which keeps
    // `useSearchParams` correct with no RSC round-trip — `router.replace`
    // changes the cache key and buys a cold fetch for nothing.
    window.history.replaceState(null, '', `${pathname}?${params.toString()}`);
  };

  const tabs: { id: LegalTab; label: string }[] = [
    { id: 'imprint', label: t.raw('i18nComplete.textd198ed30d09b') },
    { id: 'terms', label: t.raw('i18nComplete.text4afa55bf7aec') },
    { id: 'privacy', label: t.raw('appLegalPage.line79JsxTextPrivacyPolicy') },
    { id: 'enterprise', label: 'Enterprise terms' },
  ];

  const toc: TocItem[] = (
    activeTab === 'imprint'
      ? [
          ['company-information', t.raw('appLegalPage.line97JsxTextCompanyInformation')],
          ['imprint-contact', t.raw('i18nComplete.text2b5c3d26721a')],
          ['responsible-for-content', t.raw('appLegalPage.line136JsxTextResponsibleForContent')],
          ['disclaimer', t.raw('i18nComplete.text129c678fce59')],
        ]
      : activeTab === 'terms' || activeTab === 'enterprise'
        ? (activeTab === 'terms' ? TERMS : ENTERPRISE).sections.map((section) => [section.id, section.title])
        : Object.entries(PRIVACY_TITLES)
  ).map(([id, title]) => ({ title, url: `#${id}`, depth: 2 }));

  return (
    <PageFrame>
      <LegalHeading />

      {/* The landing page's frame (`kit/page-frame.tsx`), like /security:
          one band holds the document rail (a scrolling row below `lg`), the
          document, and its contents, split by hairlines. */}
      <section className="pb-20 lg:pb-28">
        <Band>
          <div className="grid grid-cols-1 lg:grid-cols-12">
            <nav
              aria-label={t.raw('i18nComplete.text02881bb0fe83')}
              className="scrollbar-hide flex gap-x-6 overflow-x-auto border-b px-6 py-2 lg:sticky lg:top-24 lg:col-span-2 lg:flex-col lg:self-start lg:overflow-visible lg:border-b-0 lg:px-8 lg:py-10"
            >
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => handleTabChange(tab.id)}
                  aria-current={activeTab === tab.id ? 'page' : undefined}
                  aria-controls="legal-document"
                  className={railItem(activeTab === tab.id)}
                >
                  {tab.label}
                </button>
              ))}
              <Link href="/legal/subprocessors" className={railItem(false)}>
                Subprocessors
              </Link>
            </nav>

            <article
              id="legal-document"
              className="min-w-0 px-6 py-10 lg:col-span-7 lg:border-x lg:px-11 lg:py-12"
            >
              <div className="mb-10">
                <h2 className="text-foreground text-xl font-medium tracking-tight text-balance md:text-2xl lg:text-3xl">
                  {activeTab === 'imprint'
                    ? 'Imprint'
                    : activeTab === 'terms'
                      ? t.raw('i18nComplete.text4afa55bf7aec')
                      : activeTab === 'enterprise'
                        ? 'Enterprise Subscription Terms'
                        : t.raw('appLegalPage.line1531JsxTextPrivacyPolicy')}
                </h2>
                {activeTab === 'imprint' ? null : (
                  <p className="text-muted-foreground mt-2 text-sm tabular-nums">
                    {t.raw('appLegalPage.line1534JsxTextLastUpdated')}{' '}
                    {activeTab === 'terms'
                      ? TERMS_LAST_UPDATED
                      : activeTab === 'enterprise'
                        ? ENTERPRISE_TERMS_LAST_UPDATED
                        : LEGAL_LAST_UPDATED}
                  </p>
                )}
              </div>

              {activeTab === 'imprint' ? (
                <Imprint />
              ) : activeTab === 'terms' ? (
                <TermsDocument doc={TERMS} />
              ) : activeTab === 'enterprise' ? (
                <TermsDocument doc={ENTERPRISE} />
              ) : (
                <PrivacyPolicy />
              )}
            </article>

            {/* Keyed by document so the scroll-spy starts at its first section. */}
            <aside className="hidden px-8 py-12 lg:sticky lg:top-24 lg:col-span-3 lg:block lg:self-start">
              <UseCaseToc key={activeTab} items={toc} />
            </aside>
          </div>
        </Band>
      </section>
    </PageFrame>
  );
}

/**
 * The fallback mirrors the real header box so the page does not jump when
 * `useSearchParams()` resolves. Its heading is the same h1 the page renders.
 */
export default function LegalPage() {
  return (
    <Suspense
      fallback={
        <PageFrame>
          <LegalHeading />
        </PageFrame>
      }
    >
      <LegalContent />
    </Suspense>
  );
}
