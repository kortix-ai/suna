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
import { ArrowRight, Box, GitBranch, KeyRound, ScrollText, Server } from 'lucide-react';
import { motion } from 'motion/react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { FaUsers } from 'react-icons/fa';
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
          <div className="inset-0 z-0 hidden mask-t-from-70% lg:absolute">
            <WallpaperBackground wallpaperId="brandmark" />
          </div>

          <div className="mx-auto max-w-6xl">
            <section className="w-full">
              <h1 className="text-foreground mt-5 text-4xl leading-[1.1] font-medium tracking-tight md:text-5xl">
                {tHardcodedUi.raw('appHomePage.line138JsxTextTheAICommandCenter')}
                <br />
                <span className="text-muted-foreground">
                  {tHardcodedUi.raw('appHomePage.line139JsxTextForYourCompany')}
                </span>
              </h1>
              <p className="text-muted-foreground mt-6 max-w-xl text-lg leading-relaxed">
                {tHardcodedUi.raw('appHomePage.line142JsxTextRunYourCompanyOnAIEveryAgentTrigger')}
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Button size="xl" onClick={handleLaunch}>
                  {tHardcodedUi.raw('appHomePage.line146JsxTextGetStarted')}
                </Button>
                <Button size="xl" variant="secondary" asChild>
                  <Link href={DEMO_URL}>
                    {tHardcodedUi.raw('appHomePage.line149JsxTextTalkToSales')}
                  </Link>
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
              ].map(({ n, t, d }, index) => (
                <div key={n} className="relative">
                  <div
                    className="animate-kortix-bullet-flow bg-size-[100%_300%] bg-clip-text text-left text-lg font-semibold text-transparent"
                    style={{
                      backgroundImage: KORTIX_BULLET_GRADIENT,
                      animationDelay: `${index * 0.4}s`,
                    }}
                  >
                    {n}
                  </div>

                  <h3 className="text-foreground mt-5 text-lg font-semibold">{t}</h3>
                  <p className="text-muted-foreground mt-1.5 text-base leading-relaxed font-medium">
                    {d}
                  </p>
                </div>
              ))}
            </div>
          </Reveal>
        </section>

        <section className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24">
          <Reveal>
            <div className="mb-12 max-w-2xl">
              <Eyebrow>{tHardcodedUi.raw('appHomePage.line225JsxTextOpenCodeNative')}</Eyebrow>
              <h2 className="mt-3 text-3xl font-medium text-balance md:text-4xl lg:tracking-tight">
                {tHardcodedUi.raw('appHomePage.line227JsxTextYourWholeCompanyAsCode')}
              </h2>
              <p className="text-muted-foreground mt-4 text-base text-balance">
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
                  ].map(([x], index) => (
                    <li
                      key={x}
                      className="text-muted-foreground flex items-start gap-3 text-sm leading-relaxed"
                    >
                      <KortixAsterisk index={index} />
                      {x}
                    </li>
                  ))}
                </ul>

                <ItemGroup className="border-border mt-8 overflow-hidden rounded border">
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
              <Eyebrow>Integrations</Eyebrow>
              <h2 className="text-muted-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
                {tHardcodedUi.raw('appHomePage.line163JsxTextConnectsToThe')}{' '}
                <span className="text-foreground font-medium">
                  {tHardcodedUi.raw('appHomePage.line163JsxText3000Apps')}
                </span>{' '}
                {tHardcodedUi.raw('appHomePage.line163JsxTextYourCompanyAlreadyRunsOn')}
              </h2>
            </div>
          </Reveal>
          <LogoMarqueeRows />
        </section>

        <section className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24">
          <Reveal>
            <div className="mb-12 max-w-2xl">
              <Eyebrow>Enterprise</Eyebrow>
              <h2 className="mt-3 text-3xl font-medium text-balance md:text-4xl lg:tracking-tight">
                {tHardcodedUi.raw('appHomePage.line284JsxTextSecureEnoughToRunTheWholeCompany')}
              </h2>
              <p className="text-muted-foreground mt-4 text-base text-balance">
                {tHardcodedUi.raw(
                  'appHomePage.line287JsxTextFineGrainedControlOverWhoAndWhichAgent',
                )}
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="grid grid-cols-1 gap-10 md:gap-16 sm:grid-cols-2 lg:grid-cols-3">
              {[
                {
                  icon: FaUsers,
                  t: 'RBAC & roles',
                  d: 'Members, groups, and roles. Every permission scoped to people and agents alike.',
                },
                {
                  icon: MdShield,
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
                <div key={t} className="flex flex-col space-y-6">
                  <span className="shrink-0">
                    <Icon className="size-5" />
                  </span>
                  <span className="text-foreground text-lg">
                    <span className="font-semibold">{t}.</span>{' '}
                    <span className="text-muted-foreground leading-relaxed font-medium">{d}</span>
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
                ['3,000+', 'Integrations, out of the box'],
                ['1', 'Command center for everything'],
                ['24/7', 'Agents that never clock out'],
                ['100%', 'Open & self-hostable'],
              ].map(([stat, label], i) => (
                <div
                  key={label}
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
                  <p className="text-muted-foreground mt-2 text-sm">{label}</p>
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
              <div className="relative z-10 max-w-lg mx-auto">
                <h2 className="text-foreground mx-auto mt-3 max-w-2xl text-3xl leading-tight font-medium tracking-tight sm:text-4xl md:text-5xl">
                  {tHardcodedUi.raw('appHomePage.line331JsxTextGiveYourCompanyAWorkforce')}
                </h2>
                <p className="text-muted-foreground mx-auto mt-4 max-w-2xl text-base text-balance sm:text-lg">
                  {tHardcodedUi.raw('appHomePage.line334JsxTextFreeToSelfHostManagedCloudFrom20')}
                </p>
                <div className="hidden md:flex mt-8  flex-col items-center justify-center gap-3 sm:flex-row">
                  <Button asChild size="lg" variant="accent">
                    <Link href={DEMO_URL}>
                      {tHardcodedUi.raw('appHomePage.line338JsxTextTalkToSales')}
                    </Link>
                  </Button>
                  <Button size="xl" onClick={handleLaunch}>
                    {tHardcodedUi.raw('appHomePage.line337JsxTextGetStarted')}
                    <ArrowRight className="size-3.5" />
                  </Button>
                  <Button asChild size="lg" variant="accent">
                    <Link href="/pricing">
                      {tHardcodedUi.raw('appHomePage.line339JsxTextSeePricing')}
                    </Link>
                  </Button>
                </div>
                <div className="grid grid-cols-2 md:hidden mt-8   flex-col items-center justify-center gap-3 sm:flex-row">
                  <Button size="lg" className='col-span-2' onClick={handleLaunch}>
                    {tHardcodedUi.raw('appHomePage.line337JsxTextGetStarted')}
                    <ArrowRight className="size-3.5" />
                  </Button>
                  <Button asChild size="lg" className='col-span-1' variant="accent">
                    <Link href={DEMO_URL}>
                      {tHardcodedUi.raw('appHomePage.line338JsxTextTalkToSales')}
                    </Link>
                  </Button>
                  <Button asChild size="lg" className='col-span-1' variant="accent">
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
            <ArrowRight className="ml-1.5 size-3" />
          </Button>
        </div> */}
      </div>
    </>
  );
}
