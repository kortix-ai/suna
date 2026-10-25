'use client';

import Link from '@/components/site-link';
import { DemoQualifierModal } from '@/features/contact/demo-qualifier-modal';
import { useEnglishOnly } from '@/features/marketing/kit/english-only';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { splitTitle } from '@/features/marketing/kit/blocks';
import { Band, Block, CellGrid, Heading, KeyRows, PageFrame, PageHero } from '@/features/marketing/kit/page-frame';
import { Seal } from '@/features/marketing/kit/seal';
import { useTranslations } from '@/i18n/use-translations';
import { useState } from 'react';

/**
 * `/enterprise`. Strings that already exist under
 * `hardcodedUi.appHomeEnterprisePage` are read from the catalogs, so they stay
 * translated. The second title lines have no key yet, so they render in
 * English only (`useEnglishOnly`). The rewritten descriptions are new English
 * and show in English in every locale until they get keys.
 *
 * ACCURACY GATE (the security page's header has the sources):
 *  - Do NOT restore "never visible to the model" for secrets. Only CONNECTOR
 *    credentials never enter the machine. A runtime secret reaches a session
 *    through the starter's role intersected with the agent's grant.
 *  - Do NOT restore "scoped per person / per group" for secrets (retired by
 *    `20260706_secrets_v2_identifier_model.sql`).
 *  - Isolation is "its own isolated machine". "microVM" is only true on Platinum.
 *  - Approval gates are opt-in (`default_mode` falls back to `allow_all`), so
 *    write "an Ask rule pauses the call", never "risky calls pause by default".
 *  - SOC 2: Type I is held, Type II is in progress. No ISO, no HIPAA.
 *  - Dropped from the old page because nothing measures them: "rotated
 *    instantly", "audited forever", "full observability", "hundreds of
 *    teammates". ("Thousands of agents in parallel" is allowed by claims.md;
 *    it is simply not on this page.)
 *  - Scope the change-request rule to session work: dashboard config edits
 *    can commit straight to the default branch.
 *
 * Layout is the /security page's (`kit/page-frame.tsx`). No closing section:
 * the footer carries the call to action, and the hero opens the demo modal.
 */

const CAL_LINK = 'team/kortix/demo';
const CAL_NAMESPACE = 'kortix-enterprise-demo';

export default function EnterprisePage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const t = (key: string) => tHardcodedUi.raw(`appHomeEnterprisePage.${key}`) as string;
  const [calOpen, setCalOpen] = useState(false);
  const [heroTitle, heroTitleMuted] = splitTitle(t('heroTitle'));
  const englishOnly = useEnglishOnly();

  return (
    <>
      <PageFrame>
        <section id="hero">
          <PageHero
            title={heroTitle}
            titleMuted={heroTitleMuted}
            sub={t('heroDescription')}
            actions={
              <>
                <MarketingButton size="md" variant="secondary" className="hit-area-y-1" asChild>
                  <Link href="/pricing">{t('comparePlansCta')}</Link>
                </MarketingButton>
                <MarketingButton size="md" className="hit-area-y-1" onClick={() => setCalOpen(true)}>
                  {t('talkToSalesCta')}
                </MarketingButton>
              </>
            }
          />
        </section>

        {/* 1 · Governance: three ways the control plane holds. */}
        <Block id="governance">
          <Heading
            title={t('whyTitle')}
            titleMuted={englishOnly('The control plane is a git repo.')}
            sub={t('whyDescription')}
          />
          <Band className="mt-12">
            <CellGrid
              cols="lg:grid-cols-3"
              items={[
                {
                  id: 'credentials',
                  k: t('differentiatorAgentGovernanceTitle'),
                  v: 'Every connector call goes through one scoped Kortix token. The third-party credential is resolved server-side, and turning a connector off takes effect on the next call.',
                },
                {
                  id: 'policy',
                  k: t('differentiatorConnectorTitle'),
                  v: 'Each agent gets only the connectors, secrets and skills it is granted. Set allow, ask or block per action, down to the arguments of each call. An Ask rule pauses the call for a person.',
                },
                {
                  id: 'git',
                  k: t('differentiatorGitTitle'),
                  v: 'Agents, grants and policy live in kortix.yaml in a git repo. Every change, by a person or by an agent, is a diff someone reviews before it lands.',
                },
              ]}
            />
          </Band>
        </Block>

        {/* 2 · Architecture: one machine and one branch per session. */}
        <Block id="architecture">
          <Heading
            title="Isolation by default."
            titleMuted={englishOnly('One machine and one branch per session.')}
            sub="Every session runs on its own isolated machine, on its own git branch. Session work reaches main through a change request."
          />
          <Band className="mt-12">
            <CellGrid
              cols="lg:grid-cols-3"
              items={[
                {
                  id: 'sandbox',
                  k: t('architectureSandboxTitle'),
                  v: 'Each session gets an isolated machine with a clone of the project repo. Sessions never share a filesystem.',
                },
                {
                  id: 'branch',
                  k: t('architectureBranchTitle'),
                  v: t('architectureBranchDescription'),
                },
                {
                  id: 'members',
                  k: 'Built for whole companies',
                  v: 'Members are free and unlimited, with one shared credit pool. Everyone works in the same repo, each in their own sessions.',
                },
              ]}
            />
          </Band>
        </Block>

        {/* 3 · Controls: what a security review asks about, then compliance. */}
        <Block id="controls">
          <Heading
            title={t('securityTitle')}
            titleMuted={englishOnly('In one place.')}
            sub="The controls a security review asks about. The security page has the detail behind each one."
            actions={
              <MarketingButton size="md" variant="secondary" className="hit-area-y-1" asChild>
                <Link href="/security">Read the security page</Link>
              </MarketingButton>
            }
          />
          <div className="mt-6">
            <KeyRows
              rows={[
                {
                  id: 'saml',
                  k: 'SAML 2.0 SSO',
                  v: 'Sign in with your identity provider, with just-in-time provisioning and group-claim mapping.',
                },
                {
                  id: 'scim',
                  k: 'SCIM 2.0',
                  v: 'Directory sync for people and groups, built against Okta and Microsoft Entra.',
                },
                {
                  id: 'rbac',
                  k: t('checklistRbacTitle'),
                  v: 'Custom roles and fine-grained policy bindings beyond the built-in roles. A person or a group can be narrowed to named agents and skills.',
                },
                {
                  id: 'audit',
                  k: 'Audit export and streaming',
                  v: 'Pull the audit log as CSV or JSONL, or stream every event to your SIEM over a webhook signed with HMAC-SHA256.',
                },
                {
                  id: 'secrets',
                  k: t('checklistSecretsTitle'),
                  v: t('checklistSecretsDescription'),
                },
              ]}
            />
          </div>
          <div className="grid grid-cols-1 items-center gap-10 px-8 pt-12 lg:grid-cols-12 lg:px-28">
            <div className="lg:col-span-5">
              <h3 className="text-foreground text-base font-medium">SOC 2 and GDPR</h3>
              <p className="text-muted-foreground mt-2 text-sm text-pretty">
                SOC 2 Type I is held. SOC 2 Type II is in progress. GDPR is a posture we run, with a DPA on Enterprise.
              </p>
            </div>
            <ul className="flex flex-wrap items-center gap-4 lg:col-span-7 lg:justify-end">
              <li>
                <Seal name="SOC 2" detail="Type I" ornament="double" />
              </li>
              <li>
                <Seal name="SOC 2" detail="Type II" note="In progress" ornament="ticks" />
              </li>
              <li>
                <Seal name="GDPR" detail="Operated" ornament="stars" />
              </li>
            </ul>
          </div>
        </Block>

        {/* 4 · Deployment: the same stack in every deployment. */}
        <Block id="deployment">
          <Heading
            title={t('deploymentTitle')}
            titleMuted={englishOnly('Run it where your policy says.')}
            sub="Kortix is open source, and the same stack runs in every deployment. Every config, every session and every file of context stays yours."
          />
          <Band className="mt-12">
            <CellGrid
              cols="lg:grid-cols-3"
              items={[
                {
                  id: 'cloud',
                  k: t('deploymentManagedCloudTitle'),
                  v: t('deploymentManagedCloudDescription'),
                },
                {
                  id: 'vpc',
                  k: t('deploymentPrivateVpcTitle'),
                  v: t('deploymentPrivateVpcDescription'),
                },
                {
                  id: 'onprem',
                  k: t('deploymentOnPremTitle'),
                  v: t('deploymentOnPremDescription'),
                },
              ]}
            />
          </Band>
        </Block>
      </PageFrame>

      <DemoQualifierModal
        open={calOpen}
        onOpenChange={setCalOpen}
        calLink={CAL_LINK}
        calNamespace={CAL_NAMESPACE}
        source="contact"
      />
    </>
  );
}
