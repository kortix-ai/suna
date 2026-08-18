'use client';

import { Reveal } from '@/components/home/reveal';
import { KORTIX_BULLET_GRADIENT, KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { DemoQualifierModal } from '@/features/contact/demo-qualifier-modal';
import { EnterpriseHeroVisual } from '@/features/marketing/enterprise/hero-visual';
import { CapabilityHero } from '@/features/marketing/component/capability-hero';
import { cn } from '@/lib/utils';
import {
  PackageIcon as Box,
  BuildingsIcon as Building2,
  UsersIcon as FaUsers,
  GitBranchIcon as GitBranch,
  KeyIcon as KeyRound,
  ShieldIcon as MdShield,
  HardDrivesIcon as Server,
} from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

const DIFFERENTIATORS = [
  {
    icon: KeyRound,
    eyebrowKey: 'differentiatorAgentGovernanceEyebrow',
    titleKey: 'differentiatorAgentGovernanceTitle',
    descriptionKey: 'differentiatorAgentGovernanceDescription',
  },
  {
    icon: MdShield,
    eyebrowKey: 'differentiatorConnectorEyebrow',
    titleKey: 'differentiatorConnectorTitle',
    descriptionKey: 'differentiatorConnectorDescription',
  },
  {
    icon: GitBranch,
    eyebrowKey: 'differentiatorGitEyebrow',
    titleKey: 'differentiatorGitTitle',
    descriptionKey: 'differentiatorGitDescription',
  },
] as const;

/**
 * Copy for these keys lives in `translations/*.json` under
 * `hardcodedUi.appHomeEnterprisePage`.
 *
 * ACCURACY GATE on `checklistSecretsDescription`: do NOT restore "never visible
 * to the model". A granted runtime secret is a real env value inside the
 * session, readable by any command the agent runs — see
 * `docs/ENV_SECRET_EXPOSURE_BASELINE.md`. The two true, narrower claims are the
 * ones in the string today: CONNECTOR credentials are brokered server-side and
 * never enter the machine, and delivery of a runtime secret is gated by the
 * role of the person who started the session intersected with the agent grant.
 * Do NOT restore "scoped per person / per group" either — retired by migration
 * `20260706_secrets_v2_identifier_model.sql`.
 *
 * Same rule for isolation copy on this page: the default sandbox provider runs
 * containers, not microVMs, so write "its own isolated machine". "microVM" is
 * only accurate where the provider is Platinum.
 */
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
    titleKey: 'checklistSecretsTitle',
    descriptionKey: 'checklistSecretsDescription',
  },
  {
    titleKey: 'checklistGatewayTitle',
    descriptionKey: 'checklistGatewayDescription',
  },
] as const;

const ARCHITECTURE = [
  {
    icon: Box,
    titleKey: 'architectureSandboxTitle',
    descriptionKey: 'architectureSandboxDescription',
  },
  {
    icon: GitBranch,
    titleKey: 'architectureBranchTitle',
    descriptionKey: 'architectureBranchDescription',
  },
  {
    icon: Building2,
    titleKey: 'architectureTenantTitle',
    descriptionKey: 'architectureTenantDescription',
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

const EnterprisePage = () => {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const t = (key: string) => tHardcodedUi.raw(`appHomeEnterprisePage.${key}`);
  const [calOpen, setCalOpen] = useState(false);

  return (
    <>
      <div className="bg-background relative">
        <CapabilityHero
          eyebrow={t('heroEyebrow')}
          title={t('heroTitle')}
          sub={t('heroDescription')}
          ctaPrimary={t('talkToSalesCta')}
          onCtaPrimaryClick={() => setCalOpen(true)}
          ctaSecondary={t('comparePlansCta')}
          ctaSecondaryHref="/pricing"
          visual={<EnterpriseHeroVisual />}
        />

        <section className="mx-auto flex max-w-7xl flex-col gap-10 px-6 py-24 sm:gap-12 sm:py-30 xl:px-0">
          <Reveal>
            <div className="mb-12 max-w-2xl">
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
                  <MdShield weight="fill" className="size-4" />
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

        <section className="mx-auto flex max-w-7xl flex-col gap-10 px-6 py-24 sm:gap-12 sm:py-30 xl:px-0">
          <Reveal>
            <div className="mb-12 max-w-2xl">
              <h2 className="text-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
                {t('architectureTitle')}
              </h2>
              <p className="text-muted-foreground mt-4 text-base leading-relaxed">
                {t('architectureDescription')}
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {ARCHITECTURE.map(({ icon: Icon, titleKey, descriptionKey }) => (
                <div
                  key={titleKey}
                  className="border-border bg-card flex h-full flex-col rounded-sm border p-6 sm:p-8"
                >
                  <Icon className="text-foreground size-5" />
                  <h3 className="text-foreground mt-5 text-lg leading-tight font-medium">
                    {t(titleKey)}
                  </h3>
                  <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
                    {t(descriptionKey)}
                  </p>
                </div>
              ))}
            </div>
          </Reveal>
        </section>

        <section className="mx-auto flex max-w-7xl flex-col gap-10 px-6 py-24 sm:gap-12 sm:py-30 xl:px-0">
          <Reveal>
            <div className="mb-12 max-w-2xl">
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
                  <FaUsers weight="fill" className="size-4" />
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

        <section className="mx-auto flex max-w-7xl flex-col gap-10 px-6 py-24 sm:gap-12 sm:py-30 xl:px-0">
          <Reveal>
            <div className="mb-12 max-w-2xl">
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
      </div>

      <DemoQualifierModal
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
