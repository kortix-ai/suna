'use client';

import { DemoQualifierDialog } from '@/components/contact/demo-qualifier-dialog';
import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import { KORTIX_BULLET_GRADIENT, KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { Button } from '@/components/ui/marketing/button';
import KortixGrid from '@/components/ui/marketing/gridder';
import { KortixLetterField } from '@/components/ui/marketing/kortix-letter-field';
import { cn } from '@/lib/utils';
import { GitBranch, Server } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { FaUsers } from 'react-icons/fa';
import { MdShield } from 'react-icons/md';

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

const CAL_LINK = 'team/kortix/demo';
const CAL_NAMESPACE = 'kortix-enterprise-demo';

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

  return (
    <>
      <div className="bg-background relative">
        <section className="relative overflow-hidden px-6 pt-32 pb-12 sm:pt-36">
          <div className="absolute inset-0 z-0 mask-y-to-95%">
            <KortixLetterField seed={3382} />
          </div>
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

        <section id="cta" className="relative mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0">
          <Reveal>
            <div className="border-border bg-card relative overflow-hidden rounded-sm border text-center">
              <div className="flex grid-cols-12 flex-col-reverse gap-2 md:grid">
                <div className="col-span-4 flex flex-col items-start justify-start space-y-4 p-6 *:text-left">
                  <div className="space-y-2">
                    <Badge variant="update" className="rounded">
                      Deploy internal agents
                    </Badge>
                    <h2 className="text-foreground text-2xl leading-tight font-medium tracking-tight sm:text-3xl">
                      {t('closingTitle')}
                    </h2>

                    <span className="text-muted-foreground text-sm leading-relaxed">
                      {t('closingDescription')}
                    </span>
                  </div>

                  <div className="mt-auto grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
                    <Button size="lg" className="w-full" onClick={() => setCalOpen(true)}>
                      {t('talkToSalesCta')}
                    </Button>
                    <Button asChild size="lg" className="w-full" variant="accent">
                      <Link href="/pricing">{t('comparePlansCta')}</Link>
                    </Button>
                  </div>
                </div>
                <div className="col-span-8 mask-y-from-90% mask-x-from-90%">
                  <KortixGrid count={58} seed={4228} />
                </div>
              </div>
            </div>
          </Reveal>
        </section>

        <div className="h-24 sm:h-28" />
      </div>

      <DemoQualifierDialog
        open={calOpen}
        onOpenChange={setCalOpen}
        calLink={CAL_LINK}
        calNamespace={CAL_NAMESPACE}
        source="contact"
      />
    </>
  );
};

export default EnterprisePage;
