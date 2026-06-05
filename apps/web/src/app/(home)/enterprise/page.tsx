'use client';

import { LogoMarqueeRows } from '@/components/home/logo-marquee';
import { Reveal } from '@/components/home/reveal';
import { KORTIX_BULLET_GRADIENT, KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { Button } from '@/components/ui/marketing/button';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { EnterpriseCalModal } from '@/features/enterprise/cal-modal';
import { cn } from '@/lib/utils';
import { Code2, GitBranch, Globe, KeyRound, Plug, Server, ShieldCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { FaUsers } from 'react-icons/fa';
import { FaArrowTrendUp } from 'react-icons/fa6';
import { HiArrowRight, HiCreditCard } from 'react-icons/hi2';
import { MdShield } from 'react-icons/md';
import { RiSettings3Fill } from 'react-icons/ri';
import { TbHeadphonesFilled } from 'react-icons/tb';

const DIFFERENTIATORS = [
  {
    icon: FaUsers,
    eyebrowKey: 'differentiatorAgentGovernanceEyebrow',
    titleKey: 'differentiatorAgentGovernanceTitle',
    descriptionKey: 'differentiatorAgentGovernanceDescription',
  },
  {
    icon: MdShield,
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
    titleKey: 'checklistSamlTitle',
    descriptionKey: 'checklistSamlDescription',
  },
  {
    titleKey: 'checklistScimTitle',
    descriptionKey: 'checklistScimDescription',
  },
  {
    titleKey: 'checklistRbacTitle',
    descriptionKey: 'checklistRbacDescription',
  },
  {
    titleKey: 'checklistAuditTitle',
    descriptionKey: 'checklistAuditDescription',
  },
  {
    titleKey: 'checklistSandboxesTitle',
    descriptionKey: 'checklistSandboxesDescription',
  },
  {
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
    titleKey: 'onboardingScopingTitle',
    descriptionKey: 'onboardingScopingDescription',
  },
  {
    titleKey: 'onboardingSecurityTitle',
    descriptionKey: 'onboardingSecurityDescription',
  },
  {
    titleKey: 'onboardingDeploymentTitle',
    descriptionKey: 'onboardingDeploymentDescription',
  },
  {
    titleKey: 'onboardingRolloutTitle',
    descriptionKey: 'onboardingRolloutDescription',
  },
] as const;

const PROOF_STATS = [
  {
    tabTitleKey: 'proofStatSavedTab',
    titleKey: 'proofStatSavedTitle',
    labelKey: 'proofStatSavedLabel',
  },
  {
    tabTitleKey: 'proofStatLoggedTab',
    titleKey: 'proofStatLoggedTitle',
    labelKey: 'proofStatLoggedLabel',
  },
  {
    tabTitleKey: 'proofStatIntegrationsTab',
    titleKey: 'proofStatIntegrationsTitle',
    labelKey: 'proofStatIntegrationsLabel',
  },
  {
    tabTitleKey: 'proofStatAlwaysOnTab',
    titleKey: 'proofStatAlwaysOnTitle',
    labelKey: 'proofStatAlwaysOnLabel',
  },
] as const;

const OUTCOMES = [
  {
    icon: HiCreditCard,
    titleKey: 'outcomeFinanceTitle',
    descriptionKey: 'outcomeFinanceDescription',
  },
  {
    icon: TbHeadphonesFilled,
    titleKey: 'outcomeSupportTitle',
    descriptionKey: 'outcomeSupportDescription',
  },
  {
    icon: FaArrowTrendUp,
    titleKey: 'outcomeSalesTitle',
    descriptionKey: 'outcomeSalesDescription',
  },
  {
    icon: RiSettings3Fill,
    titleKey: 'outcomeOperationsTitle',
    descriptionKey: 'outcomeOperationsDescription',
  },
  {
    icon: Code2,
    titleKey: 'outcomeEngineeringTitle',
    descriptionKey: 'outcomeEngineeringDescription',
    linkHref: '/developers',
    linkLabelKey: 'outcomeEngineeringLinkLabel',
  },
] as const;

const ENTERPRISE_GRID = [
  {
    icon: KeyRound,
    titleKey: 'gridSsoTitle',
    descriptionKey: 'gridSsoDescription',
  },
  {
    icon: Server,
    titleKey: 'gridInfraTitle',
    descriptionKey: 'gridInfraDescription',
  },
  {
    icon: ShieldCheck,
    titleKey: 'gridComplianceTitle',
    descriptionKey: 'gridComplianceDescription',
  },
  {
    icon: Plug,
    titleKey: 'gridIntegrationsTitle',
    descriptionKey: 'gridIntegrationsDescription',
  },
  {
    icon: TbHeadphonesFilled,
    titleKey: 'gridSupportTitle',
    descriptionKey: 'gridSupportDescription',
  },
  {
    icon: Globe,
    titleKey: 'gridGlobalTitle',
    descriptionKey: 'gridGlobalDescription',
  },
] as const;

const TRUST_ITEMS = [
  {
    titleKey: 'trustSoc2Title',
    descriptionKey: 'trustSoc2Description',
  },
  {
    titleKey: 'trustGdprTitle',
    descriptionKey: 'trustGdprDescription',
  },
  {
    titleKey: 'trustEncryptedTitle',
    descriptionKey: 'trustEncryptedDescription',
  },
  {
    titleKey: 'trustResidencyTitle',
    descriptionKey: 'trustResidencyDescription',
  },
] as const;

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
      {children}
    </span>
  );
}

const EnterprisePage = () => {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const t = (key: string) => tHardcodedUi.raw(`appHomeEnterprisePage.${key}`);
  const [calOpen, setCalOpen] = useState(false);

  const hasTestimonial =
    typeof t('testimonialQuote') === 'string' && t('testimonialQuote').trim().length > 0;

  return (
    <>
      <div className="bg-background relative">
        <section className="relative overflow-hidden px-6 pt-32 pb-12 sm:pt-36">
          <div className="mx-auto max-w-6xl">
            <Reveal>
              <Eyebrow>{t('heroEyebrow')}</Eyebrow>
              <h1 className="text-foreground mt-5 max-w-4xl text-4xl leading-[1.1] font-medium tracking-tight md:text-5xl">
                {t('heroTitle')}
              </h1>
              <p className="text-muted-foreground mt-6 max-w-xl text-lg leading-relaxed">
                {t('heroDescription')}
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Button size="xl" onClick={() => setCalOpen(true)}>
                  {t('talkToSalesCta')}
                </Button>
                <Button size="xl" variant="secondary" asChild>
                  <Link href="/pricing">{t('comparePlansCta')}</Link>
                </Button>
              </div>
              <p className="text-muted-foreground mt-6 font-mono text-xs tracking-wider uppercase">
                {t('heroMicroline')}
              </p>
            </Reveal>
          </div>
        </section>

        <section className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24 xl:px-0">
          <Reveal>
            <div className="mb-8 max-w-2xl">
              <Eyebrow>{t('proofEyebrow')}</Eyebrow>
              <h2 className="text-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
                {t('proofTitle')}
              </h2>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {PROOF_STATS.map(({ tabTitleKey, titleKey, labelKey }, index) => (
                <div
                  key={titleKey}
                  className={cn(
                    'border-border bg-card flex h-full flex-col rounded-sm border p-6 sm:p-8',
                    index === 0 && 'sm:col-span-2',
                    index === PROOF_STATS.length - 1 && 'sm:col-span-2',
                  )}
                >
                  <div className="text-muted-foreground flex items-center gap-2 font-mono text-xs tracking-wider uppercase">
                    {t(tabTitleKey)}
                  </div>
                  <p className="text-muted-foreground mt-5 text-base leading-relaxed">
                    {t(titleKey)}. {t(labelKey)}
                  </p>
                </div>
              ))}
            </div>
          </Reveal>
        </section>

        <section className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24 xl:px-0">
          <Reveal>
            <div className="mb-12 max-w-2xl">
              <Eyebrow>{t('outcomesEyebrow')}</Eyebrow>
              <h2 className="text-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
                {t('outcomesTitle')}
              </h2>
              <p className="text-muted-foreground mt-4 text-base leading-relaxed">
                {t('outcomesDescription')}
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {OUTCOMES.map((outcome, index) => {
                const { icon: Icon, titleKey, descriptionKey } = outcome;
                const linkHref = 'linkHref' in outcome ? outcome.linkHref : undefined;
                const linkLabelKey = 'linkLabelKey' in outcome ? outcome.linkLabelKey : undefined;

                return (
                  <div
                    key={titleKey}
                    className={cn(
                      'border-border bg-card flex h-full flex-col rounded-sm border p-6 sm:p-8',
                      index === OUTCOMES.length - 1 && 'sm:col-span-2',
                    )}
                  >
                    <div className="text-muted-foreground flex items-center gap-2 font-mono text-xs tracking-wider uppercase">
                      <Icon className="size-5" />
                      {t(titleKey)}
                    </div>
                    <p className="text-muted-foreground mt-5 text-base leading-relaxed">
                      {t(descriptionKey)}
                    </p>
                    {linkHref && linkLabelKey ? (
                      <Link
                        href={linkHref}
                        className="text-foreground hover:text-primary mt-6 inline-flex items-center gap-1.5 text-sm font-medium transition-colors"
                      >
                        {t(linkLabelKey)}
                        <HiArrowRight className="size-3.5" />
                      </Link>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </Reveal>
        </section>

        <section className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24 xl:px-0">
          <Reveal>
            <div className="mb-12 max-w-2xl">
              <Eyebrow>{t('whyEyebrow')}</Eyebrow>
              <h2 className="text-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
                {t('whyTitle')}
              </h2>
              <p className="text-muted-foreground mt-4 text-base leading-relaxed">
                {t('whyDescription')}
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="border-border bg-card grid overflow-hidden rounded-sm border lg:grid-cols-12">
              <article className="border-border group border-b p-8 transition-colors duration-200 lg:col-span-7 lg:border-r">
                <div className="text-muted-foreground flex items-center gap-2 font-mono text-xs tracking-wider uppercase">
                  <MdShield className="size-4" />
                  {t('moatEyebrow')}
                </div>
                <p className="text-foreground mt-5 max-w-2xl text-2xl leading-tight font-medium tracking-tight text-balance">
                  {t('moatTitle')}
                </p>
              </article>

              {DIFFERENTIATORS.map(
                ({ icon: Icon, eyebrowKey, titleKey, descriptionKey }, index) => (
                  <article
                    key={titleKey}
                    className={cn(
                      'border-border group p-8 transition-colors duration-200',
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
                ),
              )}
            </div>
          </Reveal>
        </section>

        <section className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24 xl:px-0">
          <Reveal>
            <div className="mb-12 max-w-2xl">
              <Eyebrow>{t('builtForScaleEyebrow')}</Eyebrow>
              <h2 className="text-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
                {t('builtForScaleTitle')}
              </h2>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {ENTERPRISE_GRID.map(({ icon: Icon, titleKey, descriptionKey }) => (
                <div
                  key={titleKey}
                  className="border-border bg-card flex h-full flex-col rounded-sm border p-6 sm:p-8"
                >
                  <span className="shrink-0">
                    <Icon className="size-5" />
                  </span>
                  <span className="text-foreground mt-6 text-lg">
                    <span className="font-semibold">{t(titleKey)}.</span>{' '}
                    <span className="text-muted-foreground leading-relaxed font-medium">
                      {t(descriptionKey)}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </Reveal>
        </section>

        <section className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24 xl:px-0">
          <Reveal>
            <div className="mb-12 max-w-2xl">
              <Eyebrow>{t('securityEyebrow')}</Eyebrow>
              <h2 className="text-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
                {t('securityTitle')}
              </h2>
              <p className="text-muted-foreground mt-4 text-base leading-relaxed">
                {t('securityDescription')}
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
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
          </Reveal>
        </section>

        <section className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24 xl:px-0">
          <Reveal>
            <div className="mb-12 max-w-2xl">
              <Eyebrow>{t('deploymentEyebrow')}</Eyebrow>
              <h2 className="text-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
                {t('deploymentTitle')}
              </h2>
              <p className="text-muted-foreground mt-4 text-base leading-relaxed">
                {t('deploymentDescription')}
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="grid grid-cols-1 gap-10 sm:grid-cols-3 md:gap-16">
              {DEPLOYMENT.map(({ labelKey, detailKey }) => (
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
          </Reveal>
        </section>

        <section className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24 xl:px-0">
          <Reveal>
            <div className="mb-14 max-w-2xl">
              <Eyebrow>{t('integrationsEyebrow')}</Eyebrow>
              <h2 className="text-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
                {t('integrationsTitle')}
              </h2>
              <p className="text-muted-foreground mt-4 text-base leading-relaxed">
                {t('integrationsDescription')}
              </p>
            </div>
          </Reveal>
          <LogoMarqueeRows />
        </section>

        {/* <section className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24 xl:px-0">
          <Reveal>
            <div className="mb-12 max-w-2xl">
              <Eyebrow>{t('trustEyebrow')}</Eyebrow>
              <h2 className="text-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
                {t('trustTitle')}
              </h2>
              <p className="text-muted-foreground mt-4 text-base leading-relaxed">
                {t('trustDescription')}
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {TRUST_ITEMS.map(({ titleKey, descriptionKey }) => (
                <div
                  key={titleKey}
                  className="border-border bg-card flex flex-col rounded-sm border p-6 text-center sm:p-8"
                >
                  <div className="text-foreground text-base font-semibold">{t(titleKey)}</div>
                  <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
                    {t(descriptionKey)}
                  </p>
                </div>
              ))}
            </div>
          </Reveal>
        </section>

        {hasTestimonial ? (
          <section className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24 xl:px-0">
            <Reveal>
              <div className="mb-12 max-w-2xl">
                <Eyebrow>{t('testimonialEyebrow')}</Eyebrow>
                <p className="text-muted-foreground mt-3 font-mono text-xs tracking-wider uppercase">
                  {t('testimonialTrustedByLabel')}
                </p>
              </div>
            </Reveal>
            <Reveal delay={0.1}>
              <blockquote className="border-border bg-card rounded-sm border p-8 sm:p-12">
                <p className="text-foreground text-xl leading-relaxed font-medium sm:text-2xl">
                  &ldquo;{t('testimonialQuote')}&rdquo;
                </p>
                <footer className="text-muted-foreground mt-6 text-sm">
                  <span className="text-foreground font-medium">{t('testimonialAuthorName')}</span>
                  {t('testimonialAuthorTitle') ? <> - {t('testimonialAuthorTitle')}</> : null}
                </footer>
              </blockquote>
            </Reveal>
          </section>
        ) : null}

        <section className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24 xl:px-0">
          <Reveal>
            <div className="mb-12 max-w-2xl">
              <Eyebrow>{t('onboardingEyebrow')}</Eyebrow>
              <h2 className="text-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
                {t('onboardingTitle')}
              </h2>
              <p className="text-muted-foreground mt-4 text-base leading-relaxed">
                {t('onboardingDescription')}
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
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
                  {ONBOARDING.map(({ titleKey, descriptionKey }) => (
                    <article
                      key={titleKey}
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
          </Reveal>
        </section> */}

        <section className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
          <Reveal>
            <div className="border-border bg-card relative overflow-hidden rounded-sm border px-6 py-20 text-center sm:py-28">
              <div className="absolute inset-0 z-0 mask-t-from-90% opacity-50">
                <WallpaperBackground wallpaperId="brandmark" />
              </div>
              <div className="relative z-10 mx-auto max-w-lg">
                <Eyebrow>{t('closingEyebrow')}</Eyebrow>
                <h2 className="text-foreground mx-auto mt-3 max-w-2xl text-3xl leading-tight font-medium tracking-tight sm:text-4xl md:text-5xl">
                  {t('closingTitle')}
                </h2>
                <p className="text-muted-foreground mx-auto mt-4 max-w-2xl text-base text-balance sm:text-lg">
                  {t('closingDescription')}
                </p>

                <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                  <Button size="lg" variant="accent" onClick={() => setCalOpen(true)}>
                    {t('talkToSalesCta')}
                  </Button>
                  <Button size="lg" variant="accent" asChild>
                    <Link href="/pricing">{t('comparePlansCta')}</Link>
                  </Button>
                </div>
                <p className="text-muted-foreground mt-7 inline-flex items-center gap-2 text-xs">
                  <GitBranch className="size-3.5" /> {t('closingFootnote')}
                </p>
              </div>
            </div>
          </Reveal>
        </section>

        <div className="h-24 sm:h-28" />
      </div>

      <EnterpriseCalModal open={calOpen} onOpenChange={setCalOpen} />
    </>
  );
};

export default EnterprisePage;
