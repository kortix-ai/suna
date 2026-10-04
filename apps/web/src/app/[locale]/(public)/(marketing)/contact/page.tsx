'use client';

import { useTranslations } from '@/i18n/use-translations';
import {
  ArrowRightIcon as ArrowRight,
  CubeIcon as Boxes,
  ClockIcon as Clock,
  LockIcon as Lock,
  EnvelopeIcon as Mail,
  PlayCircleIcon as PlayCircle,
  HardDrivesIcon as Server,
  ShieldCheckIcon as ShieldCheck,
} from '@phosphor-icons/react';
import { useState } from 'react';

import { marketingButtonVariants } from '@/components/ui/marketing/button';
import { DemoQualifierModal } from '@/features/contact/demo-qualifier-modal';
import { PageHero } from '@/features/marketing/component/page-hero';
import { CONTACT_TRANSLATION_KEYS } from '@/i18n/contact-translation-keys.generated';
import { localizeUiCatalog } from '@/i18n/localize-ui-catalog';
import { cn } from '@/lib/utils';

const PILL = 'h-11 rounded-full px-5 text-base';
const CONTACT_EMAIL = 'hey@kortix.ai';

// Public demo event (cal.com/team/kortix/demo) + a namespace unique to it.
const CAL_LINK = 'team/kortix/demo';
const CAL_NAMESPACE = 'kortix-enterprise-demo';

const VALUE_PROPS = [
  {
    icon: <PlayCircle className="size-4" />,
    title: 'A tailored walkthrough',
    desc: 'See agents run your actual workflows end-to-end — not a generic demo.',
  },
  {
    icon: <Server className="size-4" />,
    title: 'Deploy your way',
    // ACCURACY: not "air-gapped" — `self-host start` pulls images from
    // docker.io. Isolated topologies get scoped with us, not self-served.
    desc: 'Managed cloud, your private VPC, or your own on-prem network.',
  },
  {
    icon: <Boxes className="size-4" />,
    title: 'Batteries included',
    desc: '3,000+ connectors, 60+ skills, and agents pre-built for your industry.',
  },
  {
    icon: <ShieldCheck className="size-4" />,
    title: 'Enterprise-ready',
    desc: 'SSO, RBAC, audit logs, secrets manager — and open to audit.',
  },
  {
    icon: <Lock className="size-4" />,
    title: 'Yours to own',
    desc: 'Self-host, bring your own models, no vendor lock-in.',
  },
];

export default function ContactPage() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [open, setOpen] = useState(false);
  const valueProps = localizeUiCatalog(VALUE_PROPS, tI18nComplete, CONTACT_TRANSLATION_KEYS);

  return (
    <div className="bg-background relative">
      <PageHero
        eyebrow={tI18nHardcoded.raw(
          'autoAppPublicMarketingContactPageJsxTextEnterpriseOnPremb5a0c0b0',
        )}
        title={`${tI18nHardcoded.raw('autoAppPublicMarketingContactPageJsxTextSeeKortixRun82bdbdad')} ${tI18nHardcoded.raw('autoAppPublicMarketingContactPageJsxTextYourCompanyS9f04147b')}`}
        sub={tI18nHardcoded.raw('autoAppPublicMarketingContactPageJsxTextBookA30ee0f8c6a')}
        actions={
          <>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className={cn(marketingButtonVariants({ variant: 'default' }), PILL)}
            >
              {tI18nHardcoded.raw('autoAppPublicMarketingContactPageJsxTextBookADemofaaea0a0')}
              <ArrowRight className="ml-1.5 size-3.5" />
            </button>
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className={cn(marketingButtonVariants({ variant: 'outline' }), PILL)}
            >
              <Mail className="mr-1.5 size-4" />
              {tI18nHardcoded.raw('autoAppPublicMarketingContactPageJsxTextEmailUs505f9598')}
            </a>
          </>
        }
      />

      <section className="mx-auto max-w-3xl px-6 py-20 md:py-24">
        <p className="text-muted-foreground inline-flex items-center gap-2 text-sm">
          <Clock className="text-foreground/60 size-4" />
          {tI18nHardcoded.raw('autoAppPublicMarketingContactPageJsxTextASolutionsEngineer7001e57e')}
        </p>

        <ul className="border-border mt-10 border-y">
          {valueProps.map(({ icon, title, desc }) => (
            <li
              key={title}
              className="border-border flex items-start gap-4 border-t py-5 first:border-t-0"
            >
              <div className="text-muted-foreground mt-0.5 flex size-6 shrink-0 items-center justify-center">
                {icon}
              </div>
              <p className="text-muted-foreground text-base leading-relaxed">
                <span className="text-foreground font-medium">{title}.</span> {desc}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <DemoQualifierModal
        open={open}
        onOpenChange={setOpen}
        calLink={CAL_LINK}
        calNamespace={CAL_NAMESPACE}
        source="contact"
      />
    </div>
  );
}
