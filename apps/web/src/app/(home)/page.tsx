'use client';

import { useAuth } from '@/components/AuthProvider';
import { CodeWindow } from '@/components/home/code-window';
import { InteractiveDemo } from '@/components/home/interactive-demo';
import { Reveal } from '@/components/home/reveal';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Button } from '@/components/ui/marketing/button';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { Icon } from '@/features/icon/icon';
import { useGitHubStars } from '@/hooks/utils/use-github-stars';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { cn } from '@/lib/utils';
import { Box, Building2, Code2, GitBranch, Server } from 'lucide-react';
import { motion } from 'motion/react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useState } from 'react';
import { FaUsers } from 'react-icons/fa';
import { HiArrowRight, HiMiniSparkles } from 'react-icons/hi2';
import { MdShield } from 'react-icons/md';
import { TbChevronUpRight } from 'react-icons/tb';

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
  // 'magento.com',
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

const MARQUEE_PX_PER_SEC = 18;

function LogoMarquee({ items, reverse = false }: { items: string[]; reverse?: boolean }) {
  const duration = (items.length * 60) / MARQUEE_PX_PER_SEC;
  const loop = [...items, ...items, ...items];
  return (
    <div className="relative overflow-hidden">
      <motion.div
        className="flex w-max"
        animate={{ x: reverse ? ['-50%', '0%'] : ['0%', '-50%'] }}
        transition={{ duration, repeat: Infinity, ease: 'linear' }}
      >
        {loop.map((d, i) => (
          <span
            key={`${d}-${i}`}
            className="bg-secondary/20 mr-3 flex h-12 shrink-0 items-center justify-center gap-4 rounded px-4"
          >
            {/* Dynamic Google favicon URLs are intentionally left outside next/image config. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={favicon(d)}
              alt=""
              width={22}
              height={22}
              loading="lazy"
              decoding="async"
              className="size-6"
            />
            <span className="text-muted-foreground font-mono text-sm tracking-wider capitalize">
              {d.split('.')[0]}
            </span>
          </span>
        ))}
      </motion.div>
    </div>
  );
}

const INTEGRATIONS_MID = Math.ceil(INTEGRATIONS.length / 3);
const INTEGRATIONS_ROW_1 = INTEGRATIONS.slice(0, INTEGRATIONS_MID);
const INTEGRATIONS_ROW_2 = INTEGRATIONS.slice(INTEGRATIONS_MID, INTEGRATIONS_MID * 2);
const INTEGRATIONS_ROW_3 = INTEGRATIONS.slice(INTEGRATIONS_MID);

const WORK_LOOPS = [
  {
    id: 'finance',
    titleKey: 'workLoopFinanceTitle',
    promptKey: 'workLoopFinancePrompt',
    agent: 'finance-agent',
    steps: [
      ['workLoopAskLabel', 'workLoopFinanceAsk'],
      ['workLoopWorkLabel', 'workLoopFinanceWork'],
      ['workLoopReviewLabel', 'workLoopFinanceReview'],
      ['workLoopDoneLabel', 'workLoopFinanceDone'],
    ],
  },
  {
    id: 'engineering',
    titleKey: 'workLoopEngineeringTitle',
    promptKey: 'workLoopEngineeringPrompt',
    agent: 'review-agent',
    steps: [
      ['workLoopAskLabel', 'workLoopEngineeringAsk'],
      ['workLoopWorkLabel', 'workLoopEngineeringWork'],
      ['workLoopReviewLabel', 'workLoopEngineeringReview'],
      ['workLoopDoneLabel', 'workLoopEngineeringDone'],
    ],
  },
  {
    id: 'sales',
    titleKey: 'workLoopSalesTitle',
    promptKey: 'workLoopSalesPrompt',
    agent: 'sdr-agent',
    steps: [
      ['workLoopAskLabel', 'workLoopSalesAsk'],
      ['workLoopWorkLabel', 'workLoopSalesWork'],
      ['workLoopReviewLabel', 'workLoopSalesReview'],
      ['workLoopDoneLabel', 'workLoopSalesDone'],
    ],
  },
] as const;

const SPLIT_PATHS = [
  {
    icon: Building2,
    eyebrowKey: 'splitCompaniesEyebrow',
    titleKey: 'splitCompaniesTitle',
    bodyKey: 'splitCompaniesBody',
    points: ['splitCompaniesPointOne', 'splitCompaniesPointTwo', 'splitCompaniesPointThree'],
    ctaKey: 'line149JsxTextTalkToSales',
    href: DEMO_URL,
    variant: 'secondary',
  },
  {
    icon: Code2,
    eyebrowKey: 'splitBuildersEyebrow',
    titleKey: 'splitBuildersTitle',
    bodyKey: 'splitBuildersBody',
    points: ['splitBuildersPointOne', 'splitBuildersPointTwo', 'splitBuildersPointThree'],
    ctaKey: 'startBuildingCta',
    href: '/auth',
    variant: 'default',
  },
] as const;

function LogoMarqueeRows() {
  return (
    <div className="relative space-y-3 mask-x-from-80%">
      <LogoMarquee items={INTEGRATIONS_ROW_1} />
      <LogoMarquee items={INTEGRATIONS_ROW_2} reverse />
      <LogoMarquee items={INTEGRATIONS_ROW_3} />
    </div>
  );
}

const KORTIX_BULLET_GRADIENT =
  'linear-gradient(to bottom, var(--kortix-red), var(--kortix-green), var(--kortix-blue), var(--kortix-yellow), var(--kortix-purple), var(--kortix-red))';

const ASTERISK_ARMS = [
  { className: 'z-10' },
  { className: 'z-20 rotate-90' },
  { className: 'z-30 rotate-45' },
  { className: 'z-40 -rotate-45' },
] as const;

function KortixAsterisk({ index }: { index: number }) {
  return (
    <div className="relative mt-1 flex size-4 shrink-0 items-center justify-center">
      {ASTERISK_ARMS.map(({ className }, armIndex) => (
        <div
          key={armIndex}
          className={cn(
            'animate-kortix-bullet-flow absolute h-2.5 w-px shrink-0 rounded-full bg-[length:100%_300%]',
            className,
          )}
          style={{
            backgroundImage: KORTIX_BULLET_GRADIENT,
            animationDelay: `${index * 0.4 + armIndex * 0.08}s`,
          }}
        />
      ))}
    </div>
  );
}

export default function Home() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [activeLoopId, setActiveLoopId] = useState<(typeof WORK_LOOPS)[number]['id']>('finance');
  const { user } = useAuth();
  const { formattedStars } = useGitHubStars('kortix-ai', 'kortix');
  const activeLoop = WORK_LOOPS.find((loop) => loop.id === activeLoopId) ?? WORK_LOOPS[0];
  const tHome = useCallback(
    (key: string) => tHardcodedUi.raw(`appHomePage.${key}`),
    [tHardcodedUi],
  );

  const handleLaunch = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  return (
    <>
      <div className="bg-background relative">
        <section className="relative overflow-hidden px-6 pt-32 pb-12 sm:pt-36">
          <div className="inset-0 z-0 hidden mask-t-from-70% lg:absolute">
            <WallpaperBackground wallpaperId="brandmark" />
          </div>

          <div className="mx-auto max-w-6xl">
            <section className="w-full">
              <h1 className="text-foreground mt-5 text-4xl leading-[1.1] font-medium tracking-tight md:text-5xl">
                {tHome('heroCommandCenter')}
                <br />
                <span className="text-muted-foreground">{tHome('heroAiWorkforce')}</span>
              </h1>
              <p className="text-muted-foreground mt-6 max-w-xl text-lg leading-relaxed">
                {tHome('heroDescription')}
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Button size="xl" variant="secondary" asChild>
                  <Link href={DEMO_URL}>
                    {tHardcodedUi.raw('appHomePage.line149JsxTextTalkToSales')}
                  </Link>
                </Button>
                <Button size="xl" onClick={handleLaunch}>
                  {tHome('startBuildingCta')}
                  <HiArrowRight className="size-4" />
                </Button>
              </div>
            </section>

            <div id="demo" className="relative z-10 mt-14 scroll-mt-24 sm:mt-20">
              <InteractiveDemo />
            </div>
          </div>
        </section>

        <section className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24">
          <Reveal>
            <div className="mb-8 max-w-2xl">
              <Eyebrow>{tHome('workLoopEyebrow')}</Eyebrow>
              <h2 className="text-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
                {tHome('workLoopTitle')}
              </h2>
              <p className="text-muted-foreground mt-4 text-base leading-relaxed">
                {tHome('workLoopDescription')}
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="border-border bg-card overflow-hidden rounded-sm border">
              <div className="border-border/60 flex flex-wrap gap-2 border-b p-3">
                {WORK_LOOPS.map((loop) => (
                  <button
                    key={loop.id}
                    type="button"
                    onClick={() => setActiveLoopId(loop.id)}
                    className={cn(
                      'rounded px-3 py-2 text-left text-sm font-medium transition-colors',
                      activeLoop.id === loop.id
                        ? 'bg-foreground text-background'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    {tHome(loop.titleKey)}
                  </button>
                ))}
              </div>
              <div className="grid gap-0 lg:grid-cols-[0.9fr_1.4fr]">
                <div className="border-border/60 border-b p-6 lg:border-r lg:border-b-0">
                  <div className="text-muted-foreground flex items-center gap-2 font-mono text-xs tracking-wider uppercase">
                    <HiMiniSparkles className="size-3.5" />
                    {activeLoop.agent}
                  </div>
                  <p className="text-foreground mt-4 text-xl leading-snug font-medium">
                    "{tHome(activeLoop.promptKey)}"
                  </p>
                </div>
                <div className="grid sm:grid-cols-2">
                  {activeLoop.steps.map(([labelKey, detailKey], index) => (
                    <div
                      key={detailKey}
                      className={cn(
                        'border-border/60 group p-6',
                        index < 2 && 'border-b',
                        index % 2 === 0 && 'sm:border-r',
                      )}
                    >
                      <div
                        className="animate-kortix-bullet-flow bg-size-[100%_300%] bg-clip-text font-mono text-xs font-semibold tracking-wider text-transparent uppercase"
                        style={{
                          backgroundImage: KORTIX_BULLET_GRADIENT,
                          animationDelay: `${index * 0.3}s`,
                        }}
                      >
                        {tHome(labelKey)}
                      </div>
                      <p className="text-muted-foreground group-hover:text-foreground mt-3 text-sm leading-relaxed font-medium transition-colors duration-200">
                        {tHome(detailKey)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Reveal>
        </section>

        <section className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24">
          <Reveal>
            <div className="mb-12 max-w-2xl">
              <Eyebrow>{tHome('splitEyebrow')}</Eyebrow>
              <h2 className="text-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
                {tHome('splitTitle')}
              </h2>
              <p className="text-muted-foreground mt-4 text-base leading-relaxed">
                {tHome('splitDescription')}
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {SPLIT_PATHS.map(
                ({ icon: Icon, eyebrowKey, titleKey, bodyKey, points, ctaKey, href, variant }) => (
                  <div
                    key={titleKey}
                    className="border-border bg-card flex h-full flex-col rounded-sm border p-6 sm:p-8"
                  >
                    <div className="text-muted-foreground flex items-center gap-2 font-mono text-xs tracking-wider uppercase">
                      <Icon className="size-4" />
                      {tHome(eyebrowKey)}
                    </div>
                    <h3 className="text-foreground mt-5 text-2xl leading-tight font-medium tracking-tight">
                      {tHome(titleKey)}
                    </h3>
                    <p className="text-muted-foreground mt-4 text-base leading-relaxed">
                      {tHome(bodyKey)}
                    </p>
                    <ul className="mt-6 space-y-3 pb-8">
                      {points.map((pointKey, index) => (
                        <li
                          key={pointKey}
                          className="text-muted-foreground flex items-start gap-3 text-sm leading-relaxed"
                        >
                          <KortixAsterisk index={index} />
                          {tHome(pointKey)}
                        </li>
                      ))}
                    </ul>
                    <Button asChild size="lg" className="mt-auto" variant={variant}>
                      <Link href={href}>
                        {tHome(ctaKey)}
                        <HiArrowRight className="size-4" />
                      </Link>
                    </Button>
                  </div>
                ),
              )}
            </div>
          </Reveal>
        </section>

        <section className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24">
          <Reveal>
            <div className="mb-12 max-w-2xl">
              <Eyebrow>{tHardcodedUi.raw('appHomePage.line225JsxTextOpenCodeNative')}</Eyebrow>
              <h2 className="mt-3 text-3xl font-medium text-balance md:text-4xl lg:tracking-tight">
                {tHome('companyAsCodeTitle')}
              </h2>
              <p className="text-muted-foreground mt-4 text-base text-balance">
                {tHome('companyAsCodeDescription')}
              </p>
            </div>
          </Reveal>

          <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-2 lg:gap-14">
            <Reveal>
              <CodeWindow />
            </Reveal>
            <Reveal delay={0.1}>
              <div className="w-full">
                <ul className="space-y-3.5">
                  {[
                    'companyAsCodeBulletConfig',
                    'companyAsCodeBulletAgents',
                    'companyAsCodeBulletGit',
                    'companyAsCodeBulletSelfHost',
                  ].map((key, index) => (
                    <li
                      key={key}
                      className="text-muted-foreground flex items-start gap-3 text-sm leading-relaxed"
                    >
                      <KortixAsterisk index={index} />
                      {tHome(key)}
                    </li>
                  ))}
                </ul>
                <ItemGroup className="border-border mx-auto mt-8 overflow-hidden rounded border text-left">
                  <Item
                    asChild
                    variant="muted"
                    size="sm"
                    className="group relative flex-nowrap rounded-none border-0"
                  >
                    <Link href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
                      <ItemMedia variant="icon" className="rounded">
                        <Icon.Github />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>
                          <span className="tabular-nums">{formattedStars}</span>{' '}
                          {tHardcodedUi.raw('appHomePage.line267JsxTextStarsOnGitHub')}
                        </ItemTitle>
                        <ItemDescription>
                          {tHardcodedUi.raw(
                            'appHomePage.line269JsxTextALeadingOpenSourceAIWorkspace',
                          )}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions className="mt-auto">
                        <span className="text-muted-foreground duration-slower absolute top-2 right-2 block shrink-0 origin-top-right translate-x-2 -translate-y-2 rotate-180 opacity-0 transition-all ease-in group-hover:translate-x-0 group-hover:translate-y-0 group-hover:-scale-100 group-hover:opacity-100 md:hidden [&>svg]:size-5">
                          <TbChevronUpRight />
                        </span>
                        <span className="text-muted-foreground font-mono text-sm max-md:hidden">
                          kortix-ai/kortix
                        </span>
                      </ItemActions>
                    </Link>
                  </Item>
                </ItemGroup>
              </div>
            </Reveal>
          </div>
        </section>

        <section className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24">
          <Reveal>
            <div className="mb-14 max-w-2xl">
              <Eyebrow>{tHome('integrationsEyebrow')}</Eyebrow>
              <h2 className="text-muted-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
                {tHome('integrationsTitlePrefix')}{' '}
                <span className="text-foreground font-medium">
                  {tHome('integrationsTitle')}
                </span>{' '}
              </h2>
              <p className="text-muted-foreground mt-4 text-base leading-relaxed">
                {tHome('integrationsDescription')}
              </p>
            </div>
          </Reveal>
          <LogoMarqueeRows />
        </section>

        <section className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24">
          <Reveal>
            <div className="mb-12 max-w-2xl">
              <Eyebrow>{tHome('enterpriseEyebrow')}</Eyebrow>
              <h2 className="mt-3 text-3xl font-medium text-balance md:text-4xl lg:tracking-tight">
                {tHome('enterpriseTitle')}
              </h2>
              <p className="text-muted-foreground mt-4 text-base text-balance">
                {tHome('enterpriseDescription')}
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="grid grid-cols-1 gap-10 sm:grid-cols-2 md:gap-16 lg:grid-cols-4">
              {[
                {
                  icon: FaUsers,
                  titleKey: 'enterpriseScopedTitle',
                  descriptionKey: 'enterpriseScopedDescription',
                },
                {
                  icon: MdShield,
                  titleKey: 'enterpriseApprovalsTitle',
                  descriptionKey: 'enterpriseApprovalsDescription',
                },
                {
                  icon: Box,
                  titleKey: 'enterpriseIsolationTitle',
                  descriptionKey: 'enterpriseIsolationDescription',
                },
                {
                  icon: Server,
                  titleKey: 'enterpriseDeployTitle',
                  descriptionKey: 'enterpriseDeployDescription',
                },
              ].map(({ icon: Icon, titleKey, descriptionKey }) => (
                <div key={titleKey} className="flex flex-col space-y-6">
                  <span className="shrink-0">
                    <Icon className="size-5" />
                  </span>
                  <span className="text-foreground text-lg">
                    <span className="font-semibold">{tHome(titleKey)}.</span>{' '}
                    <span className="text-muted-foreground leading-relaxed font-medium">
                      {tHome(descriptionKey)}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </Reveal>
        </section>

        <section className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24">
          <Reveal>
            <div className="grid grid-cols-2 md:grid-cols-4">
              {[
                ['3,000+', 'statIntegrations'],
                ['1', 'statCommandCenter'],
                ['24/7', 'statAlwaysOn'],
                ['100%', 'statOpenSelfHostable'],
              ].map(([stat, labelKey], i) => (
                <div
                  key={labelKey}
                  className={cn(
                    'hover:bg-card space-y-4 px-4 py-6 text-center sm:py-8',
                    'border-border/60 border-r border-b',
                    i % 2 === 1 && 'border-r-0',
                    i >= 2 && 'border-b-0',
                    'md:border-r md:border-b-0',
                    i % 2 === 1 && 'md:border-r',
                    i === 3 && 'md:border-r-0',
                  )}
                >
                  <div className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
                    {stat}
                  </div>
                  <p className="text-muted-foreground mt-2 text-sm">{tHome(labelKey)}</p>
                </div>
              ))}
            </div>
          </Reveal>
        </section>

        <section className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
          <Reveal>
            <div className="border-border bg-card relative overflow-hidden rounded-sm border px-6 py-20 text-center sm:py-28">
              <div className="absolute inset-0 z-0 mask-t-from-90% opacity-50">
                <WallpaperBackground wallpaperId="brandmark" />
              </div>
              <div className="relative z-10 mx-auto max-w-lg">
                <h2 className="text-foreground mx-auto mt-3 max-w-2xl text-3xl leading-tight font-medium tracking-tight sm:text-4xl md:text-5xl">
                  {tHardcodedUi.raw('appHomePage.line331JsxTextGiveYourCompanyAWorkforce')}
                </h2>
                <p className="text-muted-foreground mx-auto mt-4 max-w-2xl text-base text-balance sm:text-lg">
                  {tHardcodedUi.raw('appHomePage.line334JsxTextFreeToSelfHostManagedCloudFrom20')}
                </p>

                <div className="mt-8 hidden flex-col items-center justify-center gap-3 sm:flex-row md:flex">
                  <Button asChild size="lg" variant="accent">
                    <Link href={DEMO_URL}>
                      {tHardcodedUi.raw('appHomePage.line338JsxTextTalkToSales')}
                    </Link>
                  </Button>
                  <Button size="xl" onClick={handleLaunch}>
                    {tHardcodedUi.raw('appHomePage.line337JsxTextGetStarted')}
                    <HiArrowRight className="size-4" />
                  </Button>
                  <Button asChild size="lg" variant="accent">
                    <Link href="/pricing">
                      {tHardcodedUi.raw('appHomePage.line339JsxTextSeePricing')}
                    </Link>
                  </Button>
                </div>
                <div className="mt-8 grid grid-cols-2 flex-col items-center justify-center gap-3 sm:flex-row md:hidden">
                  <Button size="lg" className="col-span-2" onClick={handleLaunch}>
                    {tHardcodedUi.raw('appHomePage.line337JsxTextGetStarted')}
                    <HiArrowRight className="size-4" />
                  </Button>
                  <Button asChild size="lg" className="col-span-1" variant="accent">
                    <Link href={DEMO_URL}>
                      {tHardcodedUi.raw('appHomePage.line338JsxTextTalkToSales')}
                    </Link>
                  </Button>
                  <Button asChild size="lg" className="col-span-1" variant="accent">
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

        {/* <div
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
            <HiArrowRight className="ml-1.5 size-3" />
          </Button>
        </div> */}
      </div>
    </>
  );
}
