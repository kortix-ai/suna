'use client';

import { KORTIX_BULLET_GRADIENT, KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { Button } from '@/components/ui/marketing/button';
import { EnterpriseCalModal } from '@/features/enterprise/cal-modal';
import { cn } from '@/lib/utils';
import {
  ArrowRight,
  FileClock,
  GitBranch,
  KeyRound,
  LockKeyhole,
  Server,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { FaUsers } from 'react-icons/fa';
import { MdShield } from 'react-icons/md';

const DIFFERENTIATORS = [
  {
    icon: Users,
    eyebrowKey: 'differentiatorAgentGovernanceEyebrow',
    titleKey: 'differentiatorAgentGovernanceTitle',
    descriptionKey: 'differentiatorAgentGovernanceDescription',
  },
  {
    icon: ShieldCheck,
    eyebrowKey: 'differentiatorExecutorEyebrow',
    titleKey: 'differentiatorExecutorTitle',
    descriptionKey: 'differentiatorExecutorDescription',
  },
  {
    icon: GitBranch,
    eyebrowKey: 'differentiatorGitEyebrow',
    titleKey: 'differentiatorGitTitle',
    descriptionKey: 'differentiatorGitDescription',
  },
] as const;

const CHECKLIST = [
  {
    icon: LockKeyhole,
    titleKey: 'checklistSamlTitle',
    descriptionKey: 'checklistSamlDescription',
  },
  {
    icon: Users,
    titleKey: 'checklistScimTitle',
    descriptionKey: 'checklistScimDescription',
  },
  {
    icon: ShieldCheck,
    titleKey: 'checklistRbacTitle',
    descriptionKey: 'checklistRbacDescription',
  },
  {
    icon: FileClock,
    titleKey: 'checklistAuditTitle',
    descriptionKey: 'checklistAuditDescription',
  },
  {
    icon: Server,
    titleKey: 'checklistSandboxesTitle',
    descriptionKey: 'checklistSandboxesDescription',
  },
  {
    icon: KeyRound,
    titleKey: 'checklistSecretsTitle',
    descriptionKey: 'checklistSecretsDescription',
  },
] as const;

const DEPLOYMENT = [
  {
    labelKey: 'deploymentManagedCloudTitle',
    detailKey: 'deploymentManagedCloudDescription',
  },
  {
    labelKey: 'deploymentPrivateVpcTitle',
    detailKey: 'deploymentPrivateVpcDescription',
  },
  {
    labelKey: 'deploymentOnPremTitle',
    detailKey: 'deploymentOnPremDescription',
  },
] as const;

const ONBOARDING = [
  {
    step: '01',
    titleKey: 'onboardingScopingTitle',
    descriptionKey: 'onboardingScopingDescription',
  },
  {
    step: '02',
    titleKey: 'onboardingSecurityTitle',
    descriptionKey: 'onboardingSecurityDescription',
  },
  {
    step: '03',
    titleKey: 'onboardingDeploymentTitle',
    descriptionKey: 'onboardingDeploymentDescription',
  },
  {
    step: '04',
    titleKey: 'onboardingRolloutTitle',
    descriptionKey: 'onboardingRolloutDescription',
  },
] as const;

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-muted-foreground font-mono text-xs tracking-[0.2em] uppercase">
      {children}
    </span>
  );
}

const EnterprisePage = () => {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const t = (key: string) => tHardcodedUi.raw(`appHomeEnterprisePage.${key}`);
  const [calOpen, setCalOpen] = useState(false);

  return (
    <main className="bg-background relative overflow-hidden pt-28 pb-20 antialiased sm:pt-40 sm:pb-28">
      <div className="mx-auto max-w-6xl px-6 lg:px-0">
        <section className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-end">
          <div>
            <Eyebrow>{t('heroEyebrow')}</Eyebrow>
            <h1 className="text-foreground mt-5 max-w-4xl text-4xl leading-[1.05] font-medium tracking-tight text-balance md:text-6xl">
              {t('heroTitle')}
            </h1>
            <p className="text-muted-foreground mt-6 max-w-2xl text-lg leading-relaxed text-balance">
              {t('heroDescription')}
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button size="xl" onClick={() => setCalOpen(true)}>
                {t('talkToSalesCta')}
                <ArrowRight className="size-4" />
              </Button>
              <Button size="xl" variant="outline" asChild>
                <Link href="/pricing">{t('comparePlansCta')}</Link>
              </Button>
            </div>
          </div>
        </section>

        <section className="flex flex-col gap-10 py-16 sm:gap-12 sm:py-24">
          <div className="mb-2 max-w-2xl">
            <Eyebrow>{t('whyEyebrow')}</Eyebrow>
            <h2 className="text-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
              {t('whyTitle')}
            </h2>
            <p className="text-muted-foreground mt-4 text-base leading-relaxed">
              {t('whyDescription')}
            </p>
          </div>

          <div className="border-border bg-card grid overflow-hidden rounded-sm border lg:grid-cols-12">
            <article className="border-border group border-b p-6 transition-colors duration-200 lg:col-span-7 lg:border-r">
              <div className="text-muted-foreground flex items-center gap-2 font-mono text-xs tracking-wider uppercase">
                <MdShield className="size-4" />
                {t('moatEyebrow')}
              </div>
              <p className="text-foreground mt-5 max-w-2xl text-2xl leading-tight font-medium tracking-tight text-balance">
                {t('moatTitle')}
              </p>
            </article>

            {DIFFERENTIATORS.map(({ icon: Icon, eyebrowKey, titleKey, descriptionKey }, index) => (
              <article
                key={titleKey}
                className={cn(
                  'border-border group p-6 transition-colors duration-200',
                  index < 2 && 'border-b',
                  index === 0 ? 'lg:col-span-5' : 'lg:col-span-6',
                  index === 1 && 'lg:border-r lg:border-b-0',
                )}
              >
                <div className="flex items-center gap-2">
                  <Icon className="text-foreground size-4" />
                  <span
                    className="animate-kortix-bullet-flow bg-size-[100%_300%] bg-clip-text font-mono text-xs font-semibold tracking-wider text-transparent uppercase"
                    style={{
                      backgroundImage: KORTIX_BULLET_GRADIENT,
                      animationDelay: `${index * 0.3}s`,
                    }}
                  >
                    {t(eyebrowKey)}
                  </span>
                </div>
                <h3 className="text-foreground mt-5 text-lg leading-tight font-medium">
                  {t(titleKey)}
                </h3>
                <p className="text-muted-foreground group-hover:text-foreground mt-3 text-sm leading-relaxed font-medium transition-colors duration-200">
                  {t(descriptionKey)}
                </p>
              </article>
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-10 py-16 sm:gap-12 sm:py-24">
          <div className="mb-2 max-w-2xl">
            <Eyebrow>{t('securityEyebrow')}</Eyebrow>
            <h2 className="text-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
              {t('securityTitle')}
            </h2>
            <p className="text-muted-foreground mt-4 text-base leading-relaxed">
              {t('securityDescription')}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="border-border bg-card flex h-full flex-col rounded-sm border p-6 sm:p-8">
              <div className="text-muted-foreground flex items-center gap-2 font-mono text-xs tracking-wider uppercase">
                <FaUsers className="size-4" />
                {t('identityAccessEyebrow')}
              </div>
              <h3 className="text-foreground mt-5 text-2xl leading-tight font-medium tracking-tight">
                {t('identityAccessTitle')}
              </h3>
              <ul className="mt-6 space-y-3">
                {CHECKLIST.slice(0, 3).map(({ titleKey, descriptionKey }, index) => (
                  <li
                    key={titleKey}
                    className="text-muted-foreground flex items-start gap-3 text-sm leading-relaxed"
                  >
                    <KortixAsterisk index={index} />
                    <span>
                      <span className="text-foreground font-medium">{t(titleKey)}.</span>{' '}
                      {t(descriptionKey)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="border-border bg-card flex h-full flex-col rounded-sm border p-6 sm:p-8">
              <div className="text-muted-foreground flex items-center gap-2 font-mono text-xs tracking-wider uppercase">
                <Server className="size-4" />
                {t('runtimeAuditEyebrow')}
              </div>
              <h3 className="text-foreground mt-5 text-2xl leading-tight font-medium tracking-tight">
                {t('runtimeAuditTitle')}
              </h3>
              <ul className="mt-6 space-y-3">
                {CHECKLIST.slice(3).map(({ titleKey, descriptionKey }, index) => (
                  <li
                    key={titleKey}
                    className="text-muted-foreground flex items-start gap-3 text-sm leading-relaxed"
                  >
                    <KortixAsterisk index={index + 3} />
                    <span>
                      <span className="text-foreground font-medium">{t(titleKey)}.</span>{' '}
                      {t(descriptionKey)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="flex flex-col gap-10 py-16 sm:gap-12 sm:py-24">
          <div className="mb-2 max-w-2xl">
            <Eyebrow>{t('deploymentEyebrow')}</Eyebrow>
            <h2 className="text-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
              {t('deploymentTitle')}
            </h2>
            <p className="text-muted-foreground mt-4 text-base leading-relaxed">
              {t('deploymentDescription')}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-10 sm:grid-cols-3 md:gap-16">
            {DEPLOYMENT.map(({ labelKey, detailKey }, index) => (
              <div key={labelKey} className="flex flex-col space-y-6">
                <span className="shrink-0">
                  <Server className="size-5" />
                </span>
                <span className="text-foreground text-lg">
                  <span className="font-semibold">{t(labelKey)}.</span>{' '}
                  <span className="text-muted-foreground leading-relaxed font-medium">
                    {t(detailKey)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-10 py-16 sm:gap-12 sm:py-24">
          <div className="mb-2 max-w-2xl">
            <Eyebrow>{t('onboardingEyebrow')}</Eyebrow>
            <h2 className="text-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
              {t('onboardingTitle')}
            </h2>
            <p className="text-muted-foreground mt-4 text-base leading-relaxed">
              {t('onboardingDescription')}
            </p>
          </div>

          <div className="border-border bg-card overflow-hidden rounded-sm border">
            <div className="grid lg:grid-cols-[0.7fr_1.3fr]">
              <div className="border-border/60 border-b p-6 sm:p-8 lg:border-r lg:border-b-0">
                <div className="text-muted-foreground flex items-center gap-2 font-mono text-xs tracking-wider uppercase">
                  <FileClock className="size-4" />
                  {t('onboardingProcessEyebrow')}
                </div>
                <p className="text-foreground mt-5 text-2xl leading-tight font-medium tracking-tight text-balance">
                  {t('onboardingProcessTitle')}
                </p>
              </div>

              <div className="divide-border/60 divide-y">
                {ONBOARDING.map(({ step, titleKey, descriptionKey }, index) => (
                  <article
                    key={step}
                    className="group hover:bg-background/40 gap-4 p-5 transition-colors duration-200 sm:p-6"
                  >
                    <div>
                      <h3 className="text-foreground text-base font-medium">{t(titleKey)}</h3>
                      <p className="text-muted-foreground group-hover:text-foreground mt-2 text-base leading-relaxed transition-colors duration-200">
                        {t(descriptionKey)}
                      </p>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="py-16 sm:py-24">
          <div className="border-border bg-card relative overflow-hidden rounded-sm border px-6 py-20 text-center sm:py-28">
            <div className="relative z-10 mx-auto max-w-lg">
              <Eyebrow>{t('closingEyebrow')}</Eyebrow>
              <h2 className="text-foreground mx-auto mt-3 max-w-2xl text-3xl leading-tight font-medium tracking-tight sm:text-4xl md:text-5xl">
                {t('closingTitle')}
              </h2>
              <p className="text-muted-foreground mx-auto mt-4 max-w-2xl text-base text-balance sm:text-lg">
                {t('closingDescription')}
              </p>

              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <Button size="lg" onClick={() => setCalOpen(true)}>
                  {t('talkToSalesCta')}
                  <ArrowRight className="size-4" />
                </Button>
                <Button size="lg" variant="outline" asChild>
                  <Link href="/pricing">{t('comparePlansCta')}</Link>
                </Button>
              </div>
              <p className="text-muted-foreground mt-7 inline-flex items-center gap-2 text-xs">
                <GitBranch className="size-3.5" /> {t('closingFootnote')}
              </p>
            </div>
          </div>
        </section>
      </div>

      <EnterpriseCalModal open={calOpen} onOpenChange={setCalOpen} />
    </main>
  );
};

export default EnterprisePage;