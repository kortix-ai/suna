'use client';

import { ArrowRight, Package as Boxes, ClockCircle as Clock, Lock, Mail, PlayCircle, Servers as Server, ShieldCheck } from '@mynaui/icons-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { DemoQualifierModal } from '@/features/contact/demo-qualifier-modal';

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
    desc: 'Managed cloud, your private VPC, or fully on-prem / air-gapped.',
  },
  {
    icon: <Boxes className="size-4" />,
    title: 'Batteries included',
    desc: '3,000+ integrations, 60+ skills, and agents pre-built for your industry.',
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
  const [open, setOpen] = useState(false);

  return (
    <div className="bg-background relative min-h-dvh overflow-hidden">
      {/* Soft top glow — keeps the page on-brand without the busy brandmark. */}
      <div className="from-muted/40 pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-gradient-to-b to-transparent" />

      <section className="relative z-[1] mx-auto flex min-h-dvh max-w-2xl flex-col items-center justify-center px-6 py-32 text-center">
        <div className="border-border bg-background/70 text-muted-foreground inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-xs tracking-wider uppercase backdrop-blur-sm">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          {tI18nHardcoded.raw('autoAppPublicMarketingContactPageJsxTextEnterpriseOnPremb5a0c0b0')}
        </div>

        <h1 className="text-foreground mt-6 text-4xl leading-[1.04] font-medium tracking-tight sm:text-5xl md:text-6xl">
          {tI18nHardcoded.raw('autoAppPublicMarketingContactPageJsxTextSeeKortixRun82bdbdad')}
          <br />
          <span className="text-muted-foreground">
            {tI18nHardcoded.raw('autoAppPublicMarketingContactPageJsxTextYourCompanyS9f04147b')}
          </span>
        </h1>

        <p className="text-muted-foreground mt-5 max-w-xl text-base leading-relaxed sm:text-lg">
          {tI18nHardcoded.raw('autoAppPublicMarketingContactPageJsxTextBookA30ee0f8c6a')}
        </p>

        <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
          <Button
            size="lg"
            className="h-12 rounded-full px-8 text-sm"
            onClick={() => setOpen(true)}
          >
            {tI18nHardcoded.raw('autoAppPublicMarketingContactPageJsxTextBookADemofaaea0a0')}
            <ArrowRight className="ml-1.5 size-3.5" />
          </Button>
          <Button asChild size="lg" variant="outline" className="h-12 rounded-full px-7 text-sm">
            <a href={`mailto:${CONTACT_EMAIL}`}>
              <Mail className="mr-1.5 size-4" />
              {tI18nHardcoded.raw('autoAppPublicMarketingContactPageJsxTextEmailUs505f9598')}
            </a>
          </Button>
        </div>

        <p className="text-muted-foreground mt-6 inline-flex items-center gap-2 text-sm">
          <Clock className="text-foreground/60 size-4" />
          {tI18nHardcoded.raw('autoAppPublicMarketingContactPageJsxTextASolutionsEngineer7001e57e')}
        </p>

        {/* Value props — minimal list, balanced regardless of count. */}
        <div className="mx-auto mt-16 flex w-full max-w-md flex-col gap-5 text-left">
          {VALUE_PROPS.map(({ icon, title, desc }) => (
            <div key={title} className="flex items-start gap-3.5">
              <div className="text-muted-foreground mt-0.5 flex size-7 shrink-0 items-center justify-center">
                {icon}
              </div>
              <p className="text-muted-foreground text-sm leading-relaxed">
                <span className="text-foreground font-medium">{title}.</span> {desc}
              </p>
            </div>
          ))}
        </div>
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
