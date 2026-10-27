'use client';

import { useTranslations } from '@/i18n/use-translations';
import { useState } from 'react';

import { DemoQualifierModal } from '@/features/contact/demo-qualifier-modal';
import { useEnglishOnly } from '@/features/marketing/kit/english-only';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { CopyRow, LinkRow } from '@/features/marketing/kit/copy-row';
import { Band, PageFrame, PageHero } from '@/features/marketing/kit/page-frame';
import { CONTACT_TRANSLATION_KEYS } from '@/i18n/contact-translation-keys.generated';
import { localizeUiCatalog } from '@kortix/ui/i18n';

const CONTACT_EMAIL = 'hey@kortix.ai';
const SUPPORT_EMAIL = 'support@kortix.com';
const SECURITY_EMAIL = 'security@kortix.com';
const DISCORD_URL = 'https://discord.com/invite/RvFhXUdZ9H';

// Public demo event (cal.com/team/kortix/demo) + a namespace unique to it.
const CAL_LINK = 'team/kortix/demo';
const CAL_NAMESPACE = 'kortix-enterprise-demo';

/* The English two-line heading. Other locales show the translated "See Kortix
   run your company's work" as a one-line title (`useEnglishOnly`), so the
   heading never mixes two languages. */
const HEADING = {
  title: 'Talk to the team.',
  titleMuted: "See Kortix run your company's work.",
} as const;

/* Every line traces to a row in kortix-brand `claims.md`, word for word. No
   number: the star count is the only sanctioned one, and it is not here. */
const VALUE_PROPS = [
  {
    title: 'A tailored walkthrough',
    desc: 'See agents run your actual workflows end to end, not a generic demo.',
  },
  {
    title: 'Deploy your way',
    // ACCURACY: not "air-gapped" — `self-host start` pulls images from
    // docker.io. Isolated topologies get scoped with us, not self-served.
    desc: 'Run it on Kortix Cloud, in your VPC, or on your own on-prem network.',
  },
  {
    title: 'Access and audit',
    desc: 'Per-resource permissions for people and agents. Roles, groups, and an audit trail. SAML 2.0 single sign-on and SCIM 2.0.',
  },
  {
    title: 'Compliance',
    desc: 'SOC 2 Type I is held. SOC 2 Type II is in progress.',
  },
  {
    title: 'Yours to own',
    desc: 'Open source. Read it, fork it, audit it. Any model provider with your own keys.',
  },
];

// The email rows copy their address on click (`CopyRow`); Community opens
// the Discord invite in a new tab (`LinkRow`), like the careers page's links.
const CHANNELS = [
  { label: 'General', value: CONTACT_EMAIL },
  { label: 'Support', value: SUPPORT_EMAIL },
  { label: 'Security', value: SECURITY_EMAIL },
  { label: 'Community', value: 'Discord', href: DISCORD_URL },
] as const;

/**
 * `/contact`, in the landing page's frame (`kit/page-frame.tsx`) like
 * /security and /about: the two-line hero with the demo actions, then one
 * band with the ways to reach us as click-to-copy rows on the left (after
 * Lexington astromaxsp `contact/channels`) and what the demo covers on the
 * right. The demo request stays the `DemoQualifierModal` flow with
 * `source="contact"`.
 */
export default function ContactPage() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [open, setOpen] = useState(false);
  const valueProps = localizeUiCatalog(VALUE_PROPS, tI18nComplete, CONTACT_TRANSLATION_KEYS);
  const englishOnly = useEnglishOnly();
  const translatedTitle = `${tI18nHardcoded.raw('autoAppPublicMarketingContactPageJsxTextSeeKortixRun82bdbdad')} ${tI18nHardcoded.raw('autoAppPublicMarketingContactPageJsxTextYourCompanyS9f04147b')}`;

  return (
    <PageFrame>
      <section id="hero" className="pb-20 lg:pb-28">
        <PageHero
          title={englishOnly(HEADING.title) ?? translatedTitle}
          titleMuted={englishOnly(HEADING.titleMuted)}
          sub={tI18nHardcoded.raw('autoAppPublicMarketingContactPageJsxTextBookA30ee0f8c6a')}
          actions={
            <>
              <MarketingButton size="md" className="hit-area-y-1" variant="secondary" asChild>
                <a href={`mailto:${CONTACT_EMAIL}`}>
                  {tI18nHardcoded.raw('autoAppPublicMarketingContactPageJsxTextEmailUs505f9598')}
                </a>
              </MarketingButton>
              <MarketingButton size="md" className="hit-area-y-1" onClick={() => setOpen(true)}>
                {tI18nHardcoded.raw('autoAppPublicMarketingContactPageJsxTextBookADemofaaea0a0')}
              </MarketingButton>
            </>
          }
        />
        <Band>
          <div className="grid grid-cols-1 lg:grid-cols-2">
            <div className="flex flex-col px-6 py-4 lg:px-11 lg:py-6">
              <ul className="divide-y">
                {CHANNELS.map((channel) => (
                  <li key={channel.label}>
                    {'href' in channel ? (
                      <LinkRow label={channel.label} value={channel.value} href={channel.href} />
                    ) : (
                      <CopyRow label={channel.label} value={channel.value} />
                    )}
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground border-t pt-6 pb-2 text-sm text-pretty lg:pt-8">
                {tI18nHardcoded.raw('autoAppPublicMarketingContactPageJsxTextASolutionsEngineer7001e57e')}
              </p>
            </div>
            <ul className="bg-card divide-y border-t lg:border-t-0 lg:border-l">
              {valueProps.map(({ title, desc }) => (
                <li key={title} className="flex flex-col gap-2 px-6 py-6 lg:px-11">
                  <h2 className="text-foreground text-base font-medium">{title}</h2>
                  <p className="text-muted-foreground text-sm text-pretty">{desc}</p>
                </li>
              ))}
            </ul>
          </div>
        </Band>
      </section>

      <DemoQualifierModal
        open={open}
        onOpenChange={setOpen}
        calLink={CAL_LINK}
        calNamespace={CAL_NAMESPACE}
        source="contact"
      />
    </PageFrame>
  );
}
