'use client';

import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import { useState, useCallback } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Check,
  Copy,
  Github,
  GitBranch,
  GitPullRequest,
  Terminal,
  Server,
  Boxes,
  Cpu,
  KeyRound,
  Users,
  ShieldCheck,
  Globe,
  Image as ImageIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Reveal } from '@/components/home/reveal';

const INSTALL_CMD = 'curl -fsSL https://kortix.com/install | bash';
const GITHUB_URL = 'https://github.com/kortix-ai/suna';
const DEMO_URL = '/enterprise';

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">{children}</span>;
}

function FeatureCard({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card/40 p-5">
      <div className="flex items-center justify-center size-9 rounded-lg bg-foreground/[0.06] border border-foreground/10 text-foreground/80 mb-3.5">{icon}</div>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-1.5 text-sm text-muted-foreground leading-relaxed">{desc}</p>
    </div>
  );
}

function MediaSlot({ label, hint, aspect = 'aspect-[4/3]' }: { label: string; hint?: string; aspect?: string }) {
  return (
    <div className={cn('relative w-full overflow-hidden rounded-2xl border-2 border-dashed border-foreground/15 bg-foreground/[0.02] flex flex-col items-center justify-center text-center px-6', aspect)}>
      <div className="absolute top-3 left-3 inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-foreground/5 border border-foreground/10">
        <ImageIcon className="size-3" />
        <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">screenshot</span>
      </div>
      <span className="text-sm font-semibold text-foreground">{label}</span>
      {hint && <span className="mt-1 text-xs text-muted-foreground max-w-md">{hint}</span>}
    </div>
  );
}

function RepoMock() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="rounded-2xl border border-border/60 bg-card/20 overflow-hidden font-mono text-xs h-full">
      <div className="px-5 py-4 border-b border-border/40 flex items-center justify-between">
        <span className="text-xs uppercase tracking-widest text-muted-foreground font-medium">{tHardcodedUi.raw('appHomeTechnologyPage.line61JsxTextAcmeCoMain')}</span>
        <span className="text-xs text-muted-foreground">git-versioned</span>
      </div>
      <div className="p-4 flex flex-col gap-0.5">
        {[
          { d: 0, n: 'kortix.toml', f: true },
          { d: 0, n: '.opencode/', f: false },
          { d: 1, n: 'agents/', f: false },
          { d: 2, n: 'support.md', f: true },
          { d: 2, n: 'bookkeeping.md', f: true },
          { d: 1, n: 'skills/', f: false },
          { d: 1, n: 'commands/', f: false },
          { d: 0, n: 'memory/', f: false },
          { d: 0, n: '.secrets/', f: false },
          { d: 0, n: 'PERSIST/', f: false },
        ].map(({ d, n, f }, i) => (
          <div key={i} className="flex items-center gap-2 py-1 px-1 rounded hover:bg-muted/15 transition-colors" style={{ paddingLeft: `${d * 1.25 + 0.25}rem` }}>
            <span className="text-muted-foreground text-xs">{f ? '·' : '▸'}</span>
            <span className="text-foreground">{n}</span>
          </div>
        ))}
        <div className="mt-2 pt-2 border-t border-border/20 text-muted-foreground pl-1">{tHardcodedUi.raw('appHomeTechnologyPage.line82JsxTextSshGitTrackableGrepSearchable')}</div>
      </div>
    </div>
  );
}

function PrMock() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="rounded-2xl border border-border/60 bg-card/20 overflow-hidden font-mono text-xs h-full">
      <div className="px-5 py-4 border-b border-border/40 flex items-center gap-2">
        <GitPullRequest className="size-3.5 text-emerald-500" />
        <span className="text-foreground">{tHardcodedUi.raw('appHomeTechnologyPage.line93JsxTextSupportAgentMain')}</span>
        <span className="ml-auto text-xs uppercase tracking-widest text-muted-foreground">{tHardcodedUi.raw('appHomeTechnologyPage.line94JsxTextAwaitingReview')}</span>
      </div>
      <div className="p-4 space-y-2">
        <div className="text-muted-foreground">{tHardcodedUi.raw('appHomeTechnologyPage.line97JsxTextLearnedANewRefundPolicySkillFromSession')}</div>
        <div className="rounded-2xl bg-muted/10 border border-border/30 p-3 space-y-0.5 leading-relaxed">
          <div className="text-muted-foreground">  skills/refund-policy.md</div>
          <div className="text-emerald-500">{tHardcodedUi.raw('appHomeTechnologyPage.line100JsxTextWhenAChargeIsUnder50AndWithin')}</div>
          <div className="text-emerald-500">{tHardcodedUi.raw('appHomeTechnologyPage.line101JsxTextIssueTheRefundViaStripeAndReplyWith')}</div>
          <div className="text-emerald-500">{tHardcodedUi.raw('appHomeTechnologyPage.line102JsxTextTemplateRefundApproved')}</div>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-foreground text-background text-xs font-medium"><Check className="size-3" />{tHardcodedUi.raw('appHomeTechnologyPage.line105JsxTextApproveAmpMerge')}</span>
          <span className="text-muted-foreground">{tHardcodedUi.raw('appHomeTechnologyPage.line106JsxTextMainSelfImproves')}</span>
        </div>
      </div>
    </div>
  );
}

function ConfigMock() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="rounded-2xl border border-border/60 bg-card/20 overflow-hidden font-mono text-xs h-full">
      <div className="px-5 py-4 border-b border-border/40 flex items-center justify-between">
        <span className="text-xs uppercase tracking-widest text-muted-foreground font-medium">kortix.toml</span>
        <span className="text-xs text-muted-foreground">{tHardcodedUi.raw('appHomeTechnologyPage.line118JsxTextDeclarativeConfig')}</span>
      </div>
      <div className="p-5 leading-relaxed">
        <div className="text-muted-foreground">[project]</div>
        <div className="text-foreground">{tHardcodedUi.raw('appHomeTechnologyPage.line122JsxTextName')}<span className="text-emerald-500">{tHardcodedUi.raw('appHomeTechnologyPage.line122JsxTextQuotAcmeCoQuot')}</span></div>
        <div className="mt-2 text-muted-foreground">[sandbox]</div>
        <div className="text-foreground">{tHardcodedUi.raw('appHomeTechnologyPage.line124JsxTextImage')}<span className="text-emerald-500">{tHardcodedUi.raw('appHomeTechnologyPage.line124JsxTextQuotKortixBaseLatestQuot')}</span></div>
        <div className="mt-2 text-muted-foreground">[[triggers.cron]]</div>
        <div className="text-foreground">{tHardcodedUi.raw('appHomeTechnologyPage.line126JsxTextAgent')}<span className="text-emerald-500">{tHardcodedUi.raw('appHomeTechnologyPage.line126JsxTextQuotBriefingQuot')}</span></div>
        <div className="text-foreground">{tHardcodedUi.raw('appHomeTechnologyPage.line127JsxTextSchedule')}<span className="text-emerald-500">{tHardcodedUi.raw('appHomeTechnologyPage.line127JsxTextQuot08Quot')}</span></div>
        <div className="mt-2 text-muted-foreground">[[channels]]</div>
        <div className="text-foreground">{tHardcodedUi.raw('appHomeTechnologyPage.line129JsxTextType')}<span className="text-emerald-500">{tHardcodedUi.raw('appHomeTechnologyPage.line129JsxTextQuotSlackQuot')}</span></div>
        <div className="text-foreground">{tHardcodedUi.raw('appHomeTechnologyPage.line130JsxTextAgent')}<span className="text-emerald-500">{tHardcodedUi.raw('appHomeTechnologyPage.line130JsxTextQuotSupportQuot')}</span></div>
        <div className="mt-2 text-muted-foreground">[connectors]</div>
        <div className="text-foreground">{tHardcodedUi.raw('appHomeTechnologyPage.line132JsxTextRequired')}<span className="text-emerald-500">{tHardcodedUi.raw('appHomeTechnologyPage.line132JsxTextQuotGmailQuot')}</span>, <span className="text-emerald-500">{tHardcodedUi.raw('appHomeTechnologyPage.line132JsxTextQuotStripeQuot')}</span>, <span className="text-emerald-500">{tHardcodedUi.raw('appHomeTechnologyPage.line132JsxTextQuotSlackQuot')}</span>]</div>
      </div>
    </div>
  );
}

export default function Technology() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(INSTALL_CMD);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  return (
    <div className="relative bg-background pt-28 sm:pt-32">

      {/* ─── Hero ─── */}
      <section className="max-w-4xl mx-auto px-6 pt-8 pb-14 sm:pb-20 text-center">
        <Reveal>
          <Eyebrow>{tHardcodedUi.raw('appHomeTechnologyPage.line152JsxTextTechnologyTheFramework')}</Eyebrow>
        </Reveal>
        <Reveal delay={0.05}>
          <h1 className="mt-4 text-4xl sm:text-5xl md:text-6xl font-medium tracking-tight text-foreground leading-[1.04]">{tHardcodedUi.raw('appHomeTechnologyPage.line156JsxTextImagineACompany')}<br />
            <span className="text-muted-foreground">{tHardcodedUi.raw('appHomeTechnologyPage.line157JsxTextAsAGitRepo')}</span>
          </h1>
        </Reveal>
        <Reveal delay={0.1}>
          <p className="mt-6 text-base sm:text-lg text-muted-foreground leading-relaxed max-w-2xl mx-auto">{tHardcodedUi.raw('appHomeTechnologyPage.line162JsxTextOneFrameworkToRunYourAiNativeCompany')}</p>
        </Reveal>
        <Reveal delay={0.15}>
          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
            <Button asChild size="lg" className="h-12 px-8 text-sm rounded-full">
              <Link href={DEMO_URL}>{tHardcodedUi.raw('appHomeTechnologyPage.line168JsxTextRequestDemo')}<ArrowRight className="ml-1.5 size-3.5" /></Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-12 px-7 text-sm rounded-full">
              <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer"><Github className="mr-1.5 size-3.5" />{tHardcodedUi.raw('appHomeTechnologyPage.line171JsxTextViewOnGithub')}</a>
            </Button>
          </div>
          <button onClick={handleCopy} className="group mt-5 inline-flex items-center gap-2.5 h-9 px-4 rounded-full bg-foreground/[0.03] border border-border hover:border-foreground/20 transition-colors cursor-pointer">
            <span className="font-mono text-xs text-muted-foreground select-none">$</span>
            <code className="text-xs font-mono text-foreground tracking-tight">{INSTALL_CMD}</code>
            <div className="pl-2.5 border-l border-border">
              {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3 text-muted-foreground group-hover:text-foreground transition-colors" />}
            </div>
          </button>
        </Reveal>
      </section>

      {/* ─── The model ─── */}
      <section className="max-w-6xl mx-auto px-6 py-14 sm:py-20 border-t border-border/50">
        <Reveal>
          <div className="max-w-2xl mb-10">
            <Eyebrow>{tHardcodedUi.raw('appHomeTechnologyPage.line188JsxTextText1Company1Repo')}</Eyebrow>
            <h2 className="mt-3 text-2xl sm:text-3xl md:text-4xl font-medium tracking-tight text-foreground leading-tight">{tHardcodedUi.raw('appHomeTechnologyPage.line189JsxTextOneRepoIsTheSourceOfTruth')}</h2>
            <p className="mt-3 text-base text-muted-foreground leading-relaxed max-w-xl">{tHardcodedUi.raw('appHomeTechnologyPage.line190JsxTextAKortixProjectIsAGitRepositoryAgents')}</p>
          </div>
        </Reveal>
        <Reveal delay={0.1}>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <RepoMock />
            <PrMock />
          </div>
        </Reveal>
        <Reveal delay={0.15}>
          <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <FeatureCard icon={<GitBranch className="size-4" />} title={tHardcodedUi.raw('appHomeTechnologyPage.line201JsxAttrTitleSessionSandboxWorktree')} desc={tHardcodedUi.raw('appHomeTechnologyPage.line201JsxAttrDescEveryRunIsIsolatedOnItsOwnGit')} />
            <FeatureCard icon={<GitPullRequest className="size-4" />} title={tHardcodedUi.raw('appHomeTechnologyPage.line202JsxAttrTitlePersistViaPr')} desc={tHardcodedUi.raw('appHomeTechnologyPage.line202JsxAttrDescAnythingWorthKeepingIsCommittedToPersistAnd')} />
            <FeatureCard icon={<Terminal className="size-4" />} title={tHardcodedUi.raw('appHomeTechnologyPage.line203JsxAttrTitleLocalCloud')} desc={tHardcodedUi.raw('appHomeTechnologyPage.line203JsxAttrDescKortixInitDeployStartYourLocalDevRuntime')} />
          </div>
        </Reveal>
      </section>

      {/* ─── Config anatomy ─── */}
      <section className="max-w-6xl mx-auto px-6 py-14 sm:py-20 border-t border-border/50">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-14 items-center">
          <Reveal>
            <div>
              <Eyebrow>{tHardcodedUi.raw('appHomeTechnologyPage.line213JsxTextDeclarativeConfig')}</Eyebrow>
              <h2 className="mt-3 text-2xl sm:text-3xl md:text-4xl font-medium tracking-tight text-foreground leading-tight">{tHardcodedUi.raw('appHomeTechnologyPage.line214JsxTextDefineTheWholeCompanyInCode')}</h2>
              <p className="mt-3 text-base text-muted-foreground leading-relaxed">
                <code className="text-foreground font-mono text-sm">kortix.toml</code>{tHardcodedUi.raw('appHomeTechnologyPage.line216JsxTextDeclaresTheRuntimeSandboxImageCronAndWebhook')}<code className="text-foreground font-mono text-sm">.opencode</code>{tHardcodedUi.raw('appHomeTechnologyPage.line216JsxTextDirectoryHoldsTheAgentsSkillsCommandsToolsAnd')}</p>
              <ul className="mt-5 space-y-2.5">
                {['Engine- and provider-agnostic config', 'Reviewable diffs for every change', 'Reproducible from a clean clone'].map((b) => (
                  <li key={b} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                    <Check className="size-4 mt-0.5 text-foreground/70 shrink-0" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
          <Reveal delay={0.1}><ConfigMock /></Reveal>
        </div>
      </section>

      {/* ─── Sessions tour ─── */}
      <section className="max-w-6xl mx-auto px-6 py-14 sm:py-20 border-t border-border/50">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-14 items-center">
          <Reveal className="lg:order-2">
            <div>
              <Eyebrow>Sessions</Eyebrow>
              <h2 className="mt-3 text-2xl sm:text-3xl md:text-4xl font-medium tracking-tight text-foreground leading-tight">{tHardcodedUi.raw('appHomeTechnologyPage.line238JsxTextEverySessionIsARealIsolatedMachine')}</h2>
              <p className="mt-3 text-base text-muted-foreground leading-relaxed">{tHardcodedUi.raw('appHomeTechnologyPage.line239JsxTextEachRunGetsAFullLinuxSandboxShell')}</p>
              <ul className="mt-5 space-y-2.5">
                {['Live files + terminal for every session', 'Dozens of agents in parallel, fully isolated', 'Resume, fork, or hand off any session'].map((b) => (
                  <li key={b} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                    <Check className="size-4 mt-0.5 text-foreground/70 shrink-0" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
          <Reveal delay={0.1} className="lg:order-1">
            <MediaSlot label={tHardcodedUi.raw('appHomeTechnologyPage.line251JsxAttrLabelSessionSandboxUi')} hint={tHardcodedUi.raw('appHomeTechnologyPage.line251JsxAttrHintScreenshotFilesTerminalLiveAgentRun')} />
          </Reveal>
        </div>
      </section>

      {/* ─── Runs anywhere ─── */}
      <section className="max-w-6xl mx-auto px-6 py-14 sm:py-20 border-t border-border/50">
        <Reveal>
          <div className="max-w-2xl mb-10">
            <Eyebrow>{tHardcodedUi.raw('appHomeTechnologyPage.line260JsxTextRunsAnywhere')}</Eyebrow>
            <h2 className="mt-3 text-2xl sm:text-3xl md:text-4xl font-medium tracking-tight text-foreground leading-tight">{tHardcodedUi.raw('appHomeTechnologyPage.line261JsxTextYourInfraYourModelsYourEngine')}</h2>
            <p className="mt-3 text-base text-muted-foreground leading-relaxed max-w-xl">{tHardcodedUi.raw('appHomeTechnologyPage.line262JsxTextOpenAndSourceAvailableSelfHostItOr')}</p>
          </div>
        </Reveal>
        <Reveal delay={0.1}>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            <FeatureCard icon={<Server className="size-4" />} title="Self-host" desc={tHardcodedUi.raw('appHomeTechnologyPage.line267JsxAttrDescLaptopA5VpsYourVpcOrFully')} />
            <FeatureCard icon={<Boxes className="size-4" />} title={tHardcodedUi.raw('appHomeTechnologyPage.line268JsxAttrTitleAnyEngine')} desc={tHardcodedUi.raw('appHomeTechnologyPage.line268JsxAttrDescRunsOnOpencodeTodayBuiltToSupportClaude')} />
            <FeatureCard icon={<Cpu className="size-4" />} title={tHardcodedUi.raw('appHomeTechnologyPage.line269JsxAttrTitleAnyProvider')} desc={tHardcodedUi.raw('appHomeTechnologyPage.line269JsxAttrDescBringYourOwnApiKeysOrSubscriptionOr')} />
          </div>
        </Reveal>
      </section>

      {/* ─── Connect everything ─── */}
      <section className="max-w-6xl mx-auto px-6 py-14 sm:py-20 border-t border-border/50">
        <Reveal>
          <div className="max-w-2xl mb-10">
            <Eyebrow>{tHardcodedUi.raw('appHomeTechnologyPage.line278JsxTextConnectEverything')}</Eyebrow>
            <h2 className="mt-3 text-2xl sm:text-3xl md:text-4xl font-medium tracking-tight text-foreground leading-tight">{tHardcodedUi.raw('appHomeTechnologyPage.line279JsxTextOneSecureLayerToYourWholeStack')}</h2>
            <p className="mt-3 text-base text-muted-foreground leading-relaxed max-w-xl">{tHardcodedUi.raw('appHomeTechnologyPage.line280JsxTextConnectOnceViaOauthMcpRestOrPipedream')}</p>
          </div>
        </Reveal>
        <Reveal delay={0.1}>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            <FeatureCard icon={<Globe className="size-4" />} title={tHardcodedUi.raw('appHomeTechnologyPage.line285JsxAttrTitleAnyProtocol')} desc={tHardcodedUi.raw('appHomeTechnologyPage.line285JsxAttrDescOauthMcpRestPipedreamCli3000Integrations')} />
            <FeatureCard icon={<KeyRound className="size-4" />} title={tHardcodedUi.raw('appHomeTechnologyPage.line286JsxAttrTitleScopedInjected')} desc={tHardcodedUi.raw('appHomeTechnologyPage.line286JsxAttrDescOneTokenToTheSandboxCredentialsInjectedAt')} />
            <FeatureCard icon={<ShieldCheck className="size-4" />} title="Policy-governed" desc={tHardcodedUi.raw('appHomeTechnologyPage.line287JsxAttrDescAllowBlockOrRequireApprovalPerConnectorPer')} />
          </div>
        </Reveal>
      </section>

      {/* ─── Governance ─── */}
      <section className="max-w-6xl mx-auto px-6 py-14 sm:py-20 border-t border-border/50">
        <Reveal>
          <div className="max-w-2xl mb-10">
            <Eyebrow>{tHardcodedUi.raw('appHomeTechnologyPage.line296JsxTextSecurityAmpAccess')}</Eyebrow>
            <h2 className="mt-3 text-2xl sm:text-3xl md:text-4xl font-medium tracking-tight text-foreground leading-tight">{tHardcodedUi.raw('appHomeTechnologyPage.line297JsxTextGovernanceForHumansAndAgents')}</h2>
          </div>
        </Reveal>
        <Reveal delay={0.1}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            <FeatureCard icon={<KeyRound className="size-4" />} title={tHardcodedUi.raw('appHomeTechnologyPage.line302JsxAttrTitleSecretsManager')} desc={tHardcodedUi.raw('appHomeTechnologyPage.line302JsxAttrDescEncryptedInjectedAtTheNetworkLevelNeverExposed')} />
            <FeatureCard icon={<Users className="size-4" />} title={tHardcodedUi.raw('appHomeTechnologyPage.line303JsxAttrTitleUsersGroupsPolicies')} desc={tHardcodedUi.raw('appHomeTechnologyPage.line303JsxAttrDescEveryAgentSkillFileAndConnectorScopedPer')} />
            <FeatureCard icon={<ShieldCheck className="size-4" />} title="Human-in-the-loop" desc={tHardcodedUi.raw('appHomeTechnologyPage.line304JsxAttrDescApprovalGatesOnSensitiveActionsPersistenceRequiresA')} />
            <FeatureCard icon={<Server className="size-4" />} title={tHardcodedUi.raw('appHomeTechnologyPage.line305JsxAttrTitleOwnYourPerimeter')} desc={tHardcodedUi.raw('appHomeTechnologyPage.line305JsxAttrDescSelfHostOrSingleTenantNetworkEgressControls')} />
          </div>
        </Reveal>
      </section>

      {/* ─── Final CTA ─── */}
      <section className="max-w-5xl mx-auto px-6 py-20 sm:py-28 text-center border-t border-border/50">
        <Reveal>
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-medium tracking-tight text-foreground leading-tight">{tHardcodedUi.raw('appHomeTechnologyPage.line313JsxTextOneFrameworkToRunYourAiNativeCompany')}</h2>
        </Reveal>
        <Reveal delay={0.1}>
          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
            <Button asChild size="lg" className="h-12 px-8 text-sm rounded-full">
              <Link href={DEMO_URL}>{tHardcodedUi.raw('appHomeTechnologyPage.line318JsxTextRequestDemo')}<ArrowRight className="ml-1.5 size-3.5" /></Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-12 px-7 text-sm rounded-full">
              <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer"><Github className="mr-1.5 size-3.5" />{tHardcodedUi.raw('appHomeTechnologyPage.line321JsxTextStarOnGithub')}</a>
            </Button>
          </div>
        </Reveal>
      </section>

      <div className="h-16" />
    </div>
  );
}
