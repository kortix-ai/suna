'use client';

import { useAuth } from '@/components/AuthProvider';
import { CodeWindow } from '@/components/home/code-window';
import { InteractiveDemo } from '@/components/home/interactive-demo';
import { Reveal } from '@/components/home/reveal';
import { Button } from '@/components/ui/button';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { useGitHubStars } from '@/hooks/utils/use-github-stars';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { cn } from '@/lib/utils';
import {
  ArrowRight,
  Box,
  Check,
  GitBranch,
  Github,
  KeyRound,
  ScrollText,
  Server,
  ShieldCheck,
  Star,
  Users,
} from 'lucide-react';
import { motion } from 'motion/react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

const DEMO_URL = '/enterprise';
const GITHUB_URL = 'https://github.com/kortix-ai/suna';
const favicon = (d: string) => `https://www.google.com/s2/favicons?domain=${d}&sz=128`;

const INTEGRATIONS = [
  'gmail.com',
  'slack.com',
  'discord.com',
  'zoom.us',
  'microsoft.com',
  'telegram.org',
  'whatsapp.com',
  'twilio.com',
  'sendgrid.com',
  'mailgun.com',
  'intercom.com',
  'front.com',
  'loom.com',
  'webex.com',
  'ringcentral.com',
  'notion.so',
  'airtable.com',
  'asana.com',
  'monday.com',
  'clickup.com',
  'trello.com',
  'todoist.com',
  'evernote.com',
  'coda.io',
  'atlassian.com',
  'jira.com',
  'basecamp.com',
  'miro.com',
  'figma.com',
  'canva.com',
  'smartsheet.com',
  'wrike.com',
  'dropbox.com',
  'box.com',
  'drive.google.com',
  'onedrive.live.com',
  'wetransfer.com',
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'vercel.com',
  'netlify.com',
  'heroku.com',
  'aws.amazon.com',
  'cloud.google.com',
  'azure.microsoft.com',
  'digitalocean.com',
  'cloudflare.com',
  'docker.com',
  'sentry.io',
  'datadoghq.com',
  'pagerduty.com',
  'circleci.com',
  'npmjs.com',
  'postman.com',
  'mongodb.com',
  'redis.io',
  'supabase.com',
  'planetscale.com',
  'snowflake.com',
  'databricks.com',
  'jenkins.io',
  'linear.app',
  'salesforce.com',
  'hubspot.com',
  'pipedrive.com',
  'zoho.com',
  'close.com',
  'outreach.io',
  'salesloft.com',
  'gong.io',
  'apollo.io',
  'clearbit.com',
  'zoominfo.com',
  'copper.com',
  'mailchimp.com',
  'klaviyo.com',
  'marketo.com',
  'activecampaign.com',
  'convertkit.com',
  'hootsuite.com',
  'buffer.com',
  'sproutsocial.com',
  'semrush.com',
  'ahrefs.com',
  'mixpanel.com',
  'amplitude.com',
  'segment.com',
  'hotjar.com',
  'stripe.com',
  'paypal.com',
  'squareup.com',
  'quickbooks.intuit.com',
  'xero.com',
  'brex.com',
  'ramp.com',
  'wise.com',
  'plaid.com',
  'chargebee.com',
  'recurly.com',
  'paddle.com',
  'bill.com',
  'zendesk.com',
  'freshdesk.com',
  'helpscout.com',
  'gorgias.com',
  'kustomer.com',
  'workday.com',
  'bamboohr.com',
  'gusto.com',
  'rippling.com',
  'deel.com',
  'lever.co',
  'greenhouse.io',
  'ashbyhq.com',
  'shopify.com',
  'woocommerce.com',
  'bigcommerce.com',
  'squarespace.com',
  'wix.com',
  'webflow.com',
  'magento.com',
  'tableau.com',
  'looker.com',
  'metabase.com',
  'fivetran.com',
  'getdbt.com',
  'hex.tech',
  'typeform.com',
  'surveymonkey.com',
  'jotform.com',
  'tally.so',
  'calendly.com',
  'cal.com',
  'zapier.com',
  'make.com',
  'ifttt.com',
  'retool.com',
  'docusign.com',
  'pandadoc.com',
  'linkedin.com',
  'x.com',
  'facebook.com',
  'instagram.com',
  'youtube.com',
  'tiktok.com',
  'reddit.com',
  'pinterest.com',
  'twitch.tv',
  'openai.com',
  'anthropic.com',
  'huggingface.co',
  'perplexity.ai',
  'mistral.ai',
  'cohere.com',
  'replicate.com',
  'elevenlabs.io',
];

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
      {children}
    </span>
  );
}

const MARQUEE_PX_PER_SEC = 28;

function LogoMarquee({ items, reverse = false }: { items: string[]; reverse?: boolean }) {
  const duration = (items.length * 60) / MARQUEE_PX_PER_SEC;
  return (
    <div className="relative overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_6%,black_94%,transparent)]">
      <motion.div
        className="flex w-max"
        animate={{ x: reverse ? ['-50%', '0%'] : ['0%', '-50%'] }}
        transition={{ duration, repeat: Infinity, ease: 'linear' }}
      >
        {[0, 1].map((copy) => (
          <div key={copy} className="flex shrink-0" aria-hidden={copy > 0}>
            {items.map((d, i) => (
              <span
                key={`${copy}-${d}-${i}`}
                className="border-border/60 bg-card mr-3 flex size-12 shrink-0 items-center justify-center rounded-2xl border"
              >
                <img
                  src={favicon(d)}
                  alt=""
                  width={22}
                  height={22}
                  loading="lazy"
                  decoding="async"
                  className="size-[22px] rounded-md"
                />
              </span>
            ))}
          </div>
        ))}
      </motion.div>
    </div>
  );
}

export default function Home() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [showFloatingCta, setShowFloatingCta] = useState(false);
  const { user } = useAuth();
  const { formattedStars } = useGitHubStars('kortix-ai', 'kortix');

  useEffect(() => {
    const onScroll = () => setShowFloatingCta(window.scrollY > window.innerHeight);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const handleLaunch = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  return (
    <>
      <div className="bg-background relative">
        <section className="relative overflow-hidden px-6 pt-32 pb-12 sm:pt-36">
          <div className="absolute inset-0 z-0 mask-t-from-70%">
            <WallpaperBackground wallpaperId="brandmark" />
          </div>

          <div className="relative z-10 mx-auto flex max-w-3xl flex-col items-center text-center">
            <h1 className="text-foreground text-4xl leading-[1.04] font-medium tracking-tight sm:text-5xl md:text-6xl">
              {tHardcodedUi.raw('appHomePage.line138JsxTextTheAICommandCenter')}
              <br />
              <span className="text-muted-foreground">
                {tHardcodedUi.raw('appHomePage.line139JsxTextForYourCompany')}
              </span>
            </h1>
            <p className="text-muted-foreground mt-5 max-w-xl text-base leading-relaxed sm:text-lg">
              {tHardcodedUi.raw('appHomePage.line142JsxTextRunYourCompanyOnAIEveryAgentTrigger')}
            </p>
            <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
              <Button size="lg" className="h-12 rounded-full px-8 text-sm" onClick={handleLaunch}>
                {tHardcodedUi.raw('appHomePage.line146JsxTextGetStarted')}
                <ArrowRight className="ml-1.5 size-3.5" />
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="h-12 rounded-full px-7 text-sm"
              >
                <Link href={DEMO_URL}>
                  {tHardcodedUi.raw('appHomePage.line149JsxTextTalkToSales')}
                </Link>
              </Button>
            </div>
          </div>

          <div id="demo" className="relative z-10 mt-14 scroll-mt-24 sm:mt-20">
            <InteractiveDemo />
          </div>
        </section>

        <section className="border-border/60 bg-muted/20 border-y py-10">
          <p className="text-muted-foreground mb-7 text-center text-sm">
            {tHardcodedUi.raw('appHomePage.line163JsxTextConnectsToThe')}
            <span className="text-foreground font-medium">
              {tHardcodedUi.raw('appHomePage.line163JsxText3000Apps')}
            </span>{' '}
            {tHardcodedUi.raw('appHomePage.line163JsxTextYourCompanyAlreadyRunsOn')}
          </p>
          <LogoMarquee items={INTEGRATIONS} />
        </section>

        <section className="mx-auto max-w-6xl px-6 py-16 sm:py-20">
          <Reveal>
            <div className="border-border/60 bg-border/60 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border lg:grid-cols-4">
              {[
                ['3,000+', 'Integrations, out of the box'],
                ['1', 'Command center for everything'],
                ['24/7', 'Agents that never clock out'],
                ['100%', 'Open & self-hostable'],
              ].map(([stat, label]) => (
                <div key={label} className="bg-card/40 px-6 py-8 text-center sm:py-10">
                  <div className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
                    {stat}
                  </div>
                  <div className="text-muted-foreground mt-2 text-sm">{label}</div>
                </div>
              ))}
            </div>
          </Reveal>
        </section>

        <section className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
          <Reveal>
            <div className="mb-14 max-w-2xl">
              <Eyebrow>Rollout</Eyebrow>
              <h2 className="text-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
                {tHardcodedUi.raw('appHomePage.line193JsxTextLiveAcrossYourCompanyInWeeks')}
              </h2>
              <p className="text-muted-foreground mt-4 text-base leading-relaxed">
                {tHardcodedUi.raw('appHomePage.line196JsxTextNoRipAndReplaceStandUpYourFirst')}
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="relative grid grid-cols-1 gap-10 sm:grid-cols-2 lg:grid-cols-4">
              <div className="bg-border/70 absolute top-5 right-0 left-0 hidden h-px lg:block" />
              {[
                {
                  n: '1',
                  t: 'Set up your workspace',
                  d: 'Create a project and invite your teams, with roles and access from day one.',
                },
                {
                  n: '2',
                  t: 'Connect everything',
                  d: 'Plug in the 3,000+ tools you already run, ready for agents to use.',
                },
                {
                  n: '3',
                  t: 'Build your agents',
                  d: 'Turn your real processes into agents and skills that work the way you do.',
                },
                {
                  n: '4',
                  t: 'Roll out by department',
                  d: 'Go team by team — sales, finance, ops, support — and scale what works.',
                },
              ].map(({ n, t, d }) => (
                <div key={n} className="relative">
                  <div className="border-border bg-background text-foreground flex size-10 items-center justify-center rounded-full border text-sm font-semibold">
                    {n}
                  </div>
                  <h3 className="text-foreground mt-5 text-base font-semibold">{t}</h3>
                  <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">{d}</p>
                </div>
              ))}
            </div>
          </Reveal>
        </section>

        <section className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
          <Reveal>
            <div className="mb-12 max-w-2xl">
              <Eyebrow>{tHardcodedUi.raw('appHomePage.line225JsxTextOpenCodeNative')}</Eyebrow>
              <h2 className="text-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
                {tHardcodedUi.raw('appHomePage.line227JsxTextYourWholeCompanyAsCode')}
              </h2>
              <p className="text-muted-foreground mt-4 text-base leading-relaxed">
                {tHardcodedUi.raw(
                  'appHomePage.line230JsxTextEveryAgentSkillTriggerAndPolicyIsPlain',
                )}
                <span className="text-foreground font-medium">opencode</span>{' '}
                {tHardcodedUi.raw(
                  'appHomePage.line230JsxTextAgentRuntimeSelfHostAnywhereNoBlackBox',
                )}
              </p>
            </div>
          </Reveal>

          <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-2 lg:gap-14">
            <Reveal>
              <CodeWindow />
            </Reveal>
            <Reveal delay={0.1}>
              <div>
                <ul className="space-y-3.5">
                  {[
                    [
                      'kortix.toml declares triggers, channels, connectors, and the sandbox — versioned from the first commit.',
                    ],
                    [
                      'Agents and skills are markdown under .opencode/ — edit and ship them like any codebase.',
                    ],
                    [
                      'Every change is a git commit: open a PR, review the diff, roll back instantly.',
                    ],
                    [
                      'Self-host on your own infra, or run on Kortix cloud — bring your own models either way.',
                    ],
                  ].map(([x]) => (
                    <li
                      key={x}
                      className="text-muted-foreground flex items-start gap-3 text-sm leading-relaxed"
                    >
                      <Check className="text-foreground/70 mt-0.5 size-4 shrink-0" />
                      {x}
                    </li>
                  ))}
                </ul>

                <a
                  href={GITHUB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group border-border/60 bg-card hover:border-foreground/30 mt-7 flex items-center gap-3 rounded-2xl border p-4 transition-colors"
                >
                  <span className="border-border bg-muted/40 flex size-10 shrink-0 items-center justify-center rounded-xl border">
                    <Github className="text-foreground/80 size-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-foreground flex items-center gap-1.5 text-sm font-semibold">
                      <Star className="size-3.5 fill-current text-amber-500" />
                      {formattedStars} {tHardcodedUi.raw('appHomePage.line267JsxTextStarsOnGitHub')}
                    </div>
                    <div className="text-muted-foreground mt-0.5 text-sm">
                      {tHardcodedUi.raw('appHomePage.line269JsxTextALeadingOpenSourceAIWorkspace')}
                    </div>
                  </div>
                  <ArrowRight className="text-muted-foreground group-hover:text-foreground size-4 shrink-0 transition-all group-hover:translate-x-0.5" />
                </a>
              </div>
            </Reveal>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
          <Reveal>
            <div className="mb-12 max-w-2xl">
              <Eyebrow>Enterprise</Eyebrow>
              <h2 className="text-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
                {tHardcodedUi.raw('appHomePage.line284JsxTextSecureEnoughToRunTheWholeCompany')}
              </h2>
              <p className="text-muted-foreground mt-4 text-base leading-relaxed">
                {tHardcodedUi.raw(
                  'appHomePage.line287JsxTextFineGrainedControlOverWhoAndWhichAgent',
                )}
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="border-border/60 bg-border/60 grid grid-cols-1 gap-px overflow-hidden rounded-2xl border sm:grid-cols-2 lg:grid-cols-3">
              {[
                {
                  icon: Users,
                  t: 'RBAC & roles',
                  d: 'Members, groups, and roles. Every permission scoped to people and agents alike.',
                },
                {
                  icon: ShieldCheck,
                  t: 'Executor policies',
                  d: 'Guardrails on every action — require a human to approve anything risky or over-limit.',
                },
                {
                  icon: Box,
                  t: 'Isolated sandboxes',
                  d: 'Each session runs in its own secure, ephemeral sandbox. No shared state, no blast radius.',
                },
                {
                  icon: KeyRound,
                  t: 'Secrets vault',
                  d: 'Credentials encrypted at rest, injected at runtime, never exposed to the model or logs.',
                },
                {
                  icon: ScrollText,
                  t: 'Audit & approvals',
                  d: 'A complete, immutable trail of every action, decision, and human approval gate.',
                },
                {
                  icon: Server,
                  t: 'On-prem & VPC',
                  d: 'Deploy in your own cloud, VPC, or air-gapped. Your data never leaves your perimeter.',
                },
              ].map(({ icon: Icon, t, d }) => (
                <div key={t} className="bg-card/40 p-6">
                  <span className="border-border bg-muted/40 flex size-10 items-center justify-center rounded-xl border">
                    <Icon className="text-foreground/80 size-5" />
                  </span>
                  <h3 className="text-foreground mt-4 text-base font-semibold">{t}</h3>
                  <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">{d}</p>
                </div>
              ))}
            </div>
          </Reveal>
          <Reveal delay={0.15}>
            <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2">
              <Link
                href={DEMO_URL}
                className="text-foreground inline-flex items-center gap-1.5 text-sm font-medium transition-all hover:gap-2.5"
              >
                {tHardcodedUi.raw('appHomePage.line314JsxTextTalkToSales')}
                <ArrowRight className="size-4" />
              </Link>
              <Link
                href="/technology"
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm font-medium transition-colors"
              >
                {tHardcodedUi.raw('appHomePage.line317JsxTextSeeHowItWorks')}
              </Link>
            </div>
          </Reveal>
        </section>

        <section className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
          <Reveal>
            <div className="border-border bg-card relative overflow-hidden rounded-[28px] border px-6 py-20 text-center sm:py-28">
              <div className="absolute inset-0 z-0 opacity-50">
                <WallpaperBackground wallpaperId="brandmark" />
              </div>
              <div className="relative z-10">
                <Eyebrow>{tHardcodedUi.raw('appHomePage.line329JsxTextGetStarted')}</Eyebrow>
                <h2 className="text-foreground mx-auto mt-3 max-w-2xl text-3xl leading-tight font-medium tracking-tight sm:text-4xl md:text-5xl">
                  {tHardcodedUi.raw('appHomePage.line331JsxTextGiveYourCompanyAWorkforce')}
                </h2>
                <p className="text-muted-foreground mx-auto mt-4 max-w-xl text-base sm:text-lg">
                  {tHardcodedUi.raw('appHomePage.line334JsxTextFreeToSelfHostManagedCloudFrom20')}
                </p>
                <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                  <Button
                    size="lg"
                    className="h-12 rounded-full px-8 text-sm"
                    onClick={handleLaunch}
                  >
                    {tHardcodedUi.raw('appHomePage.line337JsxTextGetStarted')}
                    <ArrowRight className="ml-1.5 size-3.5" />
                  </Button>
                  <Button
                    asChild
                    size="lg"
                    variant="outline"
                    className="h-12 rounded-full px-7 text-sm"
                  >
                    <Link href={DEMO_URL}>
                      {tHardcodedUi.raw('appHomePage.line338JsxTextTalkToSales')}
                    </Link>
                  </Button>
                  <Button
                    asChild
                    size="lg"
                    variant="ghost"
                    className="h-12 rounded-full px-7 text-sm"
                  >
                    <Link href="/pricing">
                      {tHardcodedUi.raw('appHomePage.line339JsxTextSeePricing')}
                    </Link>
                  </Button>
                </div>
                <p className="text-muted-foreground mt-7 inline-flex items-center gap-2 text-xs">
                  <GitBranch className="size-3.5" />{' '}
                  {tHardcodedUi.raw('appHomePage.line342JsxTextOpenSourceSSORBACOnPremNoLock')}
                </p>
              </div>
            </div>
          </Reveal>
        </section>

        <div className="h-24 sm:h-28" />

        <div
          className={cn(
            'border-border bg-background/95 fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1.5 rounded-full border px-1.5 py-1.5 backdrop-blur-md transition-[transform,opacity] duration-[600ms] ease-[cubic-bezier(0.32,0.72,0,1)] will-change-transform',
            showFloatingCta
              ? 'translate-y-0 opacity-100'
              : 'pointer-events-none translate-y-16 opacity-0',
          )}
        >
          <Link
            href="/technology"
            className="text-muted-foreground hover:text-foreground hidden h-8 items-center rounded-full px-3 text-sm font-medium transition-colors sm:flex"
          >
            Technical
          </Link>
          <span className="bg-border hidden h-5 w-px sm:block" />
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:bg-foreground/[0.08] flex size-8 items-center justify-center rounded-full transition-colors"
          >
            <Github className="size-4" />
          </a>
          <Button
            size="sm"
            className="rounded-full px-5 text-xs font-medium"
            onClick={handleLaunch}
          >
            {tHardcodedUi.raw('appHomePage.line356JsxTextGetStarted')}
            <ArrowRight className="ml-1.5 size-3" />
          </Button>
        </div>
      </div>
    </>
  );
}
