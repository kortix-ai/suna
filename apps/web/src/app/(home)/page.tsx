'use client';

import { useAuth } from '@/components/AuthProvider';
import { CodeWindow } from '@/components/home/code-window';
import { InteractiveDemo } from '@/components/home/interactive-demo';
import { Reveal } from '@/components/home/reveal';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { AnimatedThinkingText } from '@/components/ui/animated-thinking-text';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { KORTIX_BULLET_GRADIENT, KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { Button } from '@/components/ui/marketing/button';
import { Textarea } from '@/components/ui/textarea';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { Icon } from '@/features/icon/icon';
import { useGitHubStars } from '@/hooks/utils/use-github-stars';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { cn } from '@/lib/utils';
import {
  AtSign,
  Box,
  Building2,
  Code2,
  FileText,
  GitBranch,
  MoreHorizontal,
  Plus,
  Server,
  Smile,
} from 'lucide-react';
import {
  AnimatePresence,
  motion,
  useInView,
  useScroll,
  useSpring,
  useTransform,
} from 'motion/react';
import { useTranslations } from 'next-intl';
import Image from 'next/image';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FaUsers } from 'react-icons/fa';
import { FiBookmark } from 'react-icons/fi';
import { HiOutlineDotsHorizontal } from 'react-icons/hi';
import { HiArrowRight, HiMiniSparkles } from 'react-icons/hi2';
import { MdShield } from 'react-icons/md';
import { PiBellFill, PiChatCircleDotsFill, PiChatsCircleFill, PiFilesFill } from 'react-icons/pi';
import { TbChevronUpRight } from 'react-icons/tb';

const DEMO_URL = '/contact';
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
            className="bg-card mr-3 flex h-12 shrink-0 items-center justify-center gap-4 rounded px-4"
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
            <span className="text-muted-foreground text-sm font-medium tracking-wider capitalize">
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

const WORKFORCE_MAP_CAPABILITIES = [
  {
    icon: HiMiniSparkles,
    titleKey: 'workforceMapAgentsTitle',
    descKey: 'workforceMapAgentsDesc',
  },
  {
    icon: GitBranch,
    titleKey: 'workforceMapAutomationsTitle',
    descKey: 'workforceMapAutomationsDesc',
  },
  {
    icon: Box,
    titleKey: 'workforceMapIntegrationsTitle',
    descKey: 'workforceMapIntegrationsDesc',
  },
  {
    icon: Server,
    titleKey: 'workforceMapMemoryTitle',
    descKey: 'workforceMapMemoryDesc',
  },
] as const;

const WORKFORCE_MAP_DOMAINS = [
  { icon: PiChatCircleDotsFill, labelKey: 'workforceMapPillCommunication' },
  { icon: FileText, labelKey: 'workforceMapPillDocs' },
  { icon: Code2, labelKey: 'workforceMapPillCode' },
  { icon: Building2, labelKey: 'workforceMapPillCrm' },
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

const MORNING_BRIEF_MARKDOWN = `##### Here's your morning brief:

- **Stripe revenue:** +$3,482
- **3 enterprise leads replied**
- **2 customers reported onboarding friction**
- **Production uptime:** 99.98%
- **GitHub:** 14 PRs merged
- **Slack:** 3 discussions need your input

##### I've prepared a detailed report if you'd like to review it.`;

const CHAT_THINKING_MS = 3000;
const CHAT_STREAM_CHARS_PER_TICK = 6;
const CHAT_STREAM_TICK_MS = 28;

function ChatMorningBriefReply() {
  const [phase, setPhase] = useState<'thinking' | 'streaming' | 'done'>('thinking');
  const [streamedContent, setStreamedContent] = useState('');

  useEffect(() => {
    const thinkingTimer = window.setTimeout(() => {
      setPhase('streaming');
    }, CHAT_THINKING_MS);

    return () => window.clearTimeout(thinkingTimer);
  }, []);

  useEffect(() => {
    if (phase !== 'streaming') return;

    let index = 0;

    const interval = window.setInterval(() => {
      index = Math.min(index + CHAT_STREAM_CHARS_PER_TICK, MORNING_BRIEF_MARKDOWN.length);
      setStreamedContent(MORNING_BRIEF_MARKDOWN.slice(0, index));

      if (index >= MORNING_BRIEF_MARKDOWN.length) {
        window.clearInterval(interval);
        setPhase('done');
      }
    }, CHAT_STREAM_TICK_MS);

    return () => window.clearInterval(interval);
  }, [phase]);

  if (phase === 'thinking') {
    return (
      <div className="flex items-center gap-1.5 py-0.5">
        <span className="relative flex size-2.5 shrink-0">
          <span className="bg-muted-foreground/30 absolute inline-flex h-full w-full animate-ping rounded-full" />
          <span className="bg-muted-foreground/50 relative inline-flex size-2.5 rounded-full" />
        </span>
        <AnimatedThinkingText
          statusText="Gathering overnight updates..."
          className="text-muted-foreground text-xs"
        />
      </div>
    );
  }

  return (
    <UnifiedMarkdown
      content={streamedContent}
      isStreaming={phase === 'streaming'}
      className="prose prose-sm [&_*]:text-muted-foreground max-w-none space-y-0 text-xs font-medium [&_*]:text-xs [&_*]:font-medium [&_div]:space-y-0 [&_h5]:font-medium [&_ul]:ml-0"
    />
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

  const screenCardsRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: screenCardsRef,
    offset: ['center end', 'start center'],
  });

  const STACK_STEP = 10;
  const SPREAD = 240;
  const smoothProgress = useSpring(scrollYProgress, {
    stiffness: 100,
    damping: 30,
    mass: 1,
    restDelta: 0.001,
  });
  const mobileCardX = useTransform(smoothProgress, [0, 1], [SPREAD + STACK_STEP * 2, 0]);
  const middleCardX = useTransform(smoothProgress, [0, 1], [SPREAD - STACK_STEP * 2, 0]);
  const desktopCardX = useTransform(smoothProgress, [0, 1], [-SPREAD, 0]);

  const chatDemoDesktopRef = useRef<HTMLDivElement>(null);
  const chatDemoMobileRef = useRef<HTMLDivElement>(null);
  const isChatDemoDesktopInView = useInView(chatDemoDesktopRef, { once: true, amount: 0.4 });
  const isChatDemoMobileInView = useInView(chatDemoMobileRef, { once: true, amount: 0.4 });
  const isChatDemoInView = isChatDemoDesktopInView || isChatDemoMobileInView;
  const [visibleChatMessages, setVisibleChatMessages] = useState(0);

  useEffect(() => {
    if (!isChatDemoInView) return;

    setVisibleChatMessages(1);
    const secondMessageTimer = window.setTimeout(() => setVisibleChatMessages(2), 2000);
    const thirdMessageTimer = window.setTimeout(() => setVisibleChatMessages(3), 4000);

    return () => {
      window.clearTimeout(secondMessageTimer);
      window.clearTimeout(thirdMessageTimer);
    };
  }, [isChatDemoInView]);

  const PATHS = [
    'M0.999991 1.00002C0.999992 25.9576 458 1.00001 458 53',
    'M326 1.00001C326 25.9575 471 1.00001 471 53',
    'M955 1.00002C955 25.9576 498 1.00001 498 53',
    'M630 1.00001C630 25.9575 485 1.00001 485 53',
  ];

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

        <section id="different-screen-section" className="py-16 sm:py-24">
          <div className="mx-auto flex max-w-6xl flex-col gap-10 px-6 sm:gap-12">
            <Reveal>
              <div className="mb-12 max-w-2xl">
                <Eyebrow>{tHardcodedUi.raw('appHomePage.line225JsxTextOpenCodeNative')}</Eyebrow>
                <h2 className="mt-3 text-3xl font-medium text-balance md:text-4xl lg:tracking-tight">
                  {tHome('differentScreenSectionTitle')}
                </h2>
                <p className="text-muted-foreground mt-4 text-base text-balance">
                  {tHome('differentScreenSectionDescription')}
                </p>
              </div>
            </Reveal>
          </div>

          <div ref={screenCardsRef} className="m-auto hidden w-full lg:block">
            <div className="flex w-full items-center justify-center px-6">
              <div className="relative mx-auto grid w-full grid-cols-16 place-items-center items-center gap-4 overflow-visible">
                <motion.div
                  style={{ x: mobileCardX }}
                  className="border-muted-foreground dark:border-card relative z-3 col-span-3 flex aspect-auto h-full shrink-0 items-center justify-center overflow-hidden rounded-xl border-4 shadow-sm"
                >
                  <img
                    src="https://play-lh.googleusercontent.com/cOVrXDLdhhoyLso-DO_R267tBMzWEayo10WvzWin7FSxYy8P09bLmzbmAVAgv4nTBTA9hxSAq55GxVGzMHcCTA=w5120-h2880"
                    alt="Mobile"
                    className="h-full w-full object-cover"
                  />

                  <div className="bg-muted-foreground absolute bottom-3.5 h-1 w-[30%] rounded-full" />
                </motion.div>

                <motion.div
                  style={{ x: middleCardX }}
                  transition={{ duration: 0.5 }}
                  className="border-primary dark:border-card bg-primary dark:bg-card relative z-2 col-span-6 flex aspect-video h-full w-full min-w-0 flex-1 flex-row items-center justify-center gap-1 rounded-[calc(var(--radius)+2px)] border-4 p-0.5 pl-0 shadow-sm"
                >
                  <div className="flex h-full min-h-0 w-12 flex-col items-center justify-start gap-5 py-2">
                    <FaUsers className="text-background/80 dark:text-primary/80 size-[1.2rem]" />
                    <PiChatsCircleFill className="text-background/80 dark:text-primary/80 size-[1.2rem]" />
                    <PiBellFill className="text-background/80 dark:text-primary/80 size-[1.2rem]" />
                    <PiFilesFill className="text-background/80 dark:text-primary/80 size-[1.2rem]" />
                    <FiBookmark className="text-background/80 dark:text-primary/80 size-[1.2rem]" />
                    <HiOutlineDotsHorizontal className="text-background/80 dark:text-primary/80 size-[1.2rem]" />
                  </div>
                  <div
                    ref={chatDemoDesktopRef}
                    className="bg-background flex h-full min-h-0 flex-1 flex-col items-end justify-end space-y-4 rounded-md p-4"
                  >
                    <AnimatePresence initial={false}>
                      {visibleChatMessages >= 1 ? (
                        <motion.div
                          key="chat-message-1"
                          initial={{
                            opacity: 0,
                            y: 10,
                          }}
                          animate={{
                            opacity: 1,
                            y: 0,
                          }}
                          transition={{
                            duration: 0.5,
                            ease: 'easeIn',
                          }}
                          className="flex w-full flex-row items-start justify-start gap-2"
                        >
                          <span className="bg-primary flex size-[2.1rem] shrink-0 items-center justify-center rounded-md">
                            <KortixLogo size={16} className="text-background" />
                          </span>
                          <div className="flex min-w-0 flex-1 flex-col gap-0">
                            <div className="flex flex-row items-center justify-start gap-1">
                              <span
                                className="text-foreground block truncate text-xs font-semibold"
                                style={{
                                  textBox: 'trim-both',
                                }}
                              >
                                Kortix
                              </span>
                              <span
                                className="bg-muted rounded-[0.2rem] p-[0.07rem] px-1 py-[0.04rem] text-[7px]"
                                style={{ textBox: 'trim-both' }}
                              >
                                APP
                              </span>
                              <span className="text-[9px]" style={{ textBox: 'trim-both' }}>
                                {new Date(Date.now()).toLocaleDateString('en-US', {
                                  year: 'numeric',
                                  month: 'long',
                                  day: 'numeric',
                                })}
                              </span>
                            </div>
                            <span
                              className="text-muted-foreground block truncate text-xs font-medium"
                              style={{
                                textBox: 'trim-both',
                              }}
                            >
                              Hey! 👋 What can I help you with?
                            </span>
                          </div>
                        </motion.div>
                      ) : null}

                      {visibleChatMessages >= 2 ? (
                        <motion.div
                          key="chat-message-2"
                          initial={{
                            opacity: 0,
                            y: 10,
                          }}
                          animate={{
                            opacity: 1,
                            y: 0,
                          }}
                          transition={{
                            duration: 0.5,
                            ease: 'easeIn',
                          }}
                          className="flex w-full flex-row items-start justify-start gap-2"
                        >
                          <span className="bg-primary relative flex size-[2.1rem] shrink-0 items-center justify-center overflow-hidden rounded-md">
                            <Image
                              src="https://ke4pydspzeg0nm0o.public.blob.vercel-storage.com/marko.png"
                              alt="Marko Kraemer"
                              className="size-full"
                              fill
                            />
                          </span>

                          <div className="flex min-w-0 flex-1 flex-col gap-0">
                            <div className="flex flex-row items-center justify-start gap-1">
                              <span
                                className="text-foreground block truncate text-xs font-semibold"
                                style={{
                                  textBox: 'trim-both',
                                }}
                              >
                                Marko
                              </span>
                              <span className="text-[9px]" style={{ textBox: 'trim-both' }}>
                                {new Date(Date.now()).toLocaleDateString('en-US', {
                                  year: 'numeric',
                                  month: 'long',
                                  day: 'numeric',
                                })}
                              </span>
                            </div>
                            <span
                              className="text-muted-foreground block truncate text-xs font-medium"
                              style={{
                                textBox: 'trim-both',
                              }}
                            >
                              What happened while I was sleeping?
                            </span>
                          </div>
                        </motion.div>
                      ) : null}

                      {visibleChatMessages >= 3 ? (
                        <motion.div
                          key="chat-message-3"
                          initial={{
                            opacity: 0,
                            y: 10,
                          }}
                          animate={{
                            opacity: 1,
                            y: 0,
                          }}
                          transition={{
                            duration: 0.3,
                            ease: 'easeIn',
                          }}
                          className="flex w-full flex-row items-start justify-start gap-2"
                        >
                          <span className="bg-primary flex size-[2.1rem] shrink-0 items-center justify-center rounded-md">
                            <KortixLogo size={16} className="text-background" />
                          </span>
                          <div className="flex min-w-0 flex-1 flex-col gap-0">
                            <div className="flex flex-row items-center justify-start gap-1">
                              <span
                                className="text-foreground block truncate text-xs font-semibold"
                                style={{
                                  textBox: 'trim-both',
                                }}
                              >
                                Kortix
                              </span>
                              <span
                                className="bg-muted rounded-[0.2rem] p-[0.07rem] px-1 py-[0.04rem] text-[7px]"
                                style={{ textBox: 'trim-both' }}
                              >
                                APP
                              </span>
                              <span className="text-[9px]" style={{ textBox: 'trim-both' }}>
                                {new Date(Date.now()).toLocaleDateString('en-US', {
                                  year: 'numeric',
                                  month: 'long',
                                  day: 'numeric',
                                })}
                              </span>
                            </div>
                            <div
                              className="text-muted-foreground block text-xs font-medium"
                              style={{
                                textBox: 'trim-both',
                              }}
                            >
                              <ChatMorningBriefReply />
                            </div>
                          </div>
                        </motion.div>
                      ) : null}
                    </AnimatePresence>

                    <div className="border-border bg-card w-full shrink-0 rounded-(--radius-lg) border">
                      <div className="px-3 py-2">
                        <Textarea
                          minHeight={20}
                          maxHeight={10}
                          placeholder="Type your message here..."
                          className="resize-none rounded-none border-none bg-transparent p-0 text-xs shadow-none focus-visible:ring-0"
                        />
                      </div>
                      <div className="flex items-center justify-between px-1.5 pb-1.5">
                        <div className="text-muted-foreground flex items-center">
                          <span className="flex size-7 items-center justify-center">
                            <Plus className="size-[1.05rem] stroke-[1.5]" />
                          </span>
                          <span className="flex size-7 items-center justify-center text-[0.8rem] font-semibold tracking-tight">
                            Aa
                          </span>
                          <span className="flex size-7 items-center justify-center">
                            <Smile className="size-[1.05rem] stroke-[1.5]" />
                          </span>
                          <span className="flex size-7 items-center justify-center">
                            <AtSign className="size-[1.05rem] stroke-[1.5]" />
                          </span>
                          <span className="flex size-7 items-center justify-center">
                            <MoreHorizontal className="size-[1.05rem] stroke-[1.5]" />
                          </span>
                        </div>
                        <div className="text-muted-foreground flex items-center">
                          <span className="flex size-7 items-center justify-center">
                            <svg
                              className="size-[1.05rem]"
                              width="24"
                              height="24"
                              fill="currentColor"
                              viewBox="0 0 24 24"
                              xmlns="http://www.w3.org/2000/svg"
                            >
                              <path d="M20.04 2.323c1.016-.355 1.992.621 1.637 1.637l-5.925 16.93c-.385 1.098-1.915 1.16-2.387.097l-2.859-6.432 4.024-4.025a.75.75 0 0 0-1.06-1.06l-4.025 4.024-6.432-2.859c-1.063-.473-1-2.002.097-2.387z" />
                            </svg>
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </motion.div>

                <motion.div
                  style={{ x: desktopCardX }}
                  transition={{ duration: 0.5 }}
                  className="border-primary dark:border-card relative z-1 col-span-7 aspect-video h-full w-full min-w-0 flex-1 rounded-[calc(var(--radius)+2px)] border-5 shadow-sm"
                >
                  <InteractiveDemo
                    gradientbg={false}
                    tab={false}
                    className="max-w-full"
                    contentClassName="max-w-full md:p-0 lg:p-0 p-0 "
                    innerClassName="border-none shadow-none bg-primary dark:bg-card rounded-none"
                    aside={false}
                  />
                </motion.div>
              </div>
            </div>
          </div>

          <div className="scrollbar-hide w-full overflow-x-auto scroll-smooth pb-12 lg:hidden">
            <div className="flex w-full gap-2 pl-6">
              <div className="border-primary dark:border-card relative aspect-9/19.5 h-[min(95vw,480px)] shrink-0 overflow-hidden rounded-xl border-4 shadow-sm">
                <img
                  src="https://play-lh.googleusercontent.com/cOVrXDLdhhoyLso-DO_R267tBMzWEayo10WvzWin7FSxYy8P09bLmzbmAVAgv4nTBTA9hxSAq55GxVGzMHcCTA=w5120-h2880"
                  alt="Mobile"
                  className="h-full w-full object-cover"
                />
                <div className="bg-muted-foreground absolute bottom-3.5 left-1/2 h-1 w-[30%] -translate-x-1/2 rounded-full" />
              </div>

              <div className="border-primary dark:border-card bg-primary dark:bg-card relative z-2 flex aspect-video h-[min(95vw,480px)] w-[100%] shrink-0 flex-row items-center justify-center gap-1 overflow-y-auto rounded-[calc(var(--radius)+2px)] border-4 p-0.5 pl-0 shadow-sm">
                <div className="flex h-full min-h-0 w-12 flex-col items-center justify-start gap-5 py-2">
                  <FaUsers className="text-background/80 dark:text-primary/80 size-[1.2rem]" />
                  <PiChatsCircleFill className="text-background/80 dark:text-primary/80 size-[1.2rem]" />
                  <PiBellFill className="text-background/80 dark:text-primary/80 size-[1.2rem]" />
                  <PiFilesFill className="text-background/80 dark:text-primary/80 size-[1.2rem]" />
                  <FiBookmark className="text-background/80 dark:text-primary/80 size-[1.2rem]" />
                  <HiOutlineDotsHorizontal className="text-background/80 dark:text-primary/80 size-[1.2rem]" />
                </div>
                <div
                  ref={chatDemoMobileRef}
                  className="bg-background flex h-full min-h-0 flex-1 flex-col items-end justify-end space-y-4 rounded-md p-4"
                >
                  <AnimatePresence initial={false}>
                    {visibleChatMessages >= 1 ? (
                      <motion.div
                        key="chat-message-1"
                        initial={{
                          opacity: 0,
                          y: 10,
                        }}
                        animate={{
                          opacity: 1,
                          y: 0,
                        }}
                        transition={{
                          duration: 0.5,
                          ease: 'easeIn',
                        }}
                        className="flex w-full flex-row items-start justify-start gap-2"
                      >
                        <span className="bg-primary flex size-[2.1rem] shrink-0 items-center justify-center rounded-md">
                          <KortixLogo size={16} className="text-background" />
                        </span>
                        <div className="flex min-w-0 flex-1 flex-col gap-0">
                          <div className="flex flex-row items-center justify-start gap-1">
                            <span
                              className="text-foreground block truncate text-xs font-semibold"
                              style={{
                                textBox: 'trim-both',
                              }}
                            >
                              Kortix
                            </span>
                            <span
                              className="bg-muted rounded-[0.2rem] p-[0.07rem] px-1 py-[0.04rem] text-[7px]"
                              style={{ textBox: 'trim-both' }}
                            >
                              APP
                            </span>
                            <span className="text-[9px]" style={{ textBox: 'trim-both' }}>
                              {new Date(Date.now()).toLocaleDateString('en-US', {
                                year: 'numeric',
                                month: 'long',
                                day: 'numeric',
                              })}
                            </span>
                          </div>
                          <span
                            className="text-muted-foreground block truncate text-xs font-medium"
                            style={{
                              textBox: 'trim-both',
                            }}
                          >
                            Hey! 👋 What can I help you with?
                          </span>
                        </div>
                      </motion.div>
                    ) : null}

                    {visibleChatMessages >= 2 ? (
                      <motion.div
                        key="chat-message-2"
                        initial={{
                          opacity: 0,
                          y: 10,
                        }}
                        animate={{
                          opacity: 1,
                          y: 0,
                        }}
                        transition={{
                          duration: 0.5,
                          ease: 'easeIn',
                        }}
                        className="flex w-full flex-row items-start justify-start gap-2"
                      >
                        <span className="bg-primary relative flex size-[2.1rem] shrink-0 items-center justify-center overflow-hidden rounded-md">
                          <Image
                            src="https://ke4pydspzeg0nm0o.public.blob.vercel-storage.com/marko.png"
                            alt="Marko Kraemer"
                            className="size-full"
                            fill
                          />
                        </span>

                        <div className="flex min-w-0 flex-1 flex-col gap-0">
                          <div className="flex flex-row items-center justify-start gap-1">
                            <span
                              className="text-foreground block truncate text-xs font-semibold"
                              style={{
                                textBox: 'trim-both',
                              }}
                            >
                              Marko
                            </span>
                            <span className="text-[9px]" style={{ textBox: 'trim-both' }}>
                              {new Date(Date.now()).toLocaleDateString('en-US', {
                                year: 'numeric',
                                month: 'long',
                                day: 'numeric',
                              })}
                            </span>
                          </div>
                          <span
                            className="text-muted-foreground block truncate text-xs font-medium"
                            style={{
                              textBox: 'trim-both',
                            }}
                          >
                            What happened while I was sleeping?
                          </span>
                        </div>
                      </motion.div>
                    ) : null}

                    {visibleChatMessages >= 3 ? (
                      <motion.div
                        key="chat-message-3"
                        initial={{
                          opacity: 0,
                          y: 10,
                        }}
                        animate={{
                          opacity: 1,
                          y: 0,
                        }}
                        transition={{
                          duration: 0.3,
                          ease: 'easeIn',
                        }}
                        className="flex w-full flex-row items-start justify-start gap-2"
                      >
                        <span className="bg-primary flex size-[2.1rem] shrink-0 items-center justify-center rounded-md">
                          <KortixLogo size={16} className="text-background" />
                        </span>
                        <div className="flex min-w-0 flex-1 flex-col gap-0">
                          <div className="flex flex-row items-center justify-start gap-1">
                            <span
                              className="text-foreground block truncate text-xs font-semibold"
                              style={{
                                textBox: 'trim-both',
                              }}
                            >
                              Kortix
                            </span>
                            <span
                              className="bg-muted rounded-[0.2rem] p-[0.07rem] px-1 py-[0.04rem] text-[7px]"
                              style={{ textBox: 'trim-both' }}
                            >
                              APP
                            </span>
                            <span className="text-[9px]" style={{ textBox: 'trim-both' }}>
                              {new Date(Date.now()).toLocaleDateString('en-US', {
                                year: 'numeric',
                                month: 'long',
                                day: 'numeric',
                              })}
                            </span>
                          </div>
                          <div
                            className="text-muted-foreground block text-xs font-medium"
                            style={{
                              textBox: 'trim-both',
                            }}
                          >
                            <ChatMorningBriefReply />
                          </div>
                        </div>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>

                  <div className="border-border bg-card w-full shrink-0 rounded-(--radius-lg) border">
                    <div className="px-3 py-2">
                      <Textarea
                        minHeight={20}
                        maxHeight={10}
                        placeholder="Type your message here..."
                        className="resize-none rounded-none border-none bg-transparent p-0 text-xs shadow-none focus-visible:ring-0"
                      />
                    </div>
                    <div className="flex items-center justify-between px-1.5 pb-1.5">
                      <div className="text-muted-foreground flex items-center">
                        <span className="flex size-7 items-center justify-center">
                          <Plus className="size-[1.05rem] stroke-[1.5]" />
                        </span>
                        <span className="flex size-7 items-center justify-center text-[0.8rem] font-semibold tracking-tight">
                          Aa
                        </span>
                        <span className="flex size-7 items-center justify-center">
                          <Smile className="size-[1.05rem] stroke-[1.5]" />
                        </span>
                        <span className="flex size-7 items-center justify-center">
                          <AtSign className="size-[1.05rem] stroke-[1.5]" />
                        </span>
                        <span className="flex size-7 items-center justify-center">
                          <MoreHorizontal className="size-[1.05rem] stroke-[1.5]" />
                        </span>
                      </div>
                      <div className="text-muted-foreground flex items-center">
                        <span className="flex size-7 items-center justify-center">
                          <svg
                            className="size-[1.05rem]"
                            width="24"
                            height="24"
                            fill="currentColor"
                            viewBox="0 0 24 24"
                            xmlns="http://www.w3.org/2000/svg"
                          >
                            <path d="M20.04 2.323c1.016-.355 1.992.621 1.637 1.637l-5.925 16.93c-.385 1.098-1.915 1.16-2.387.097l-2.859-6.432 4.024-4.025a.75.75 0 0 0-1.06-1.06l-4.025 4.024-6.432-2.859c-1.063-.473-1-2.002.097-2.387z" />
                          </svg>
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="border-primary dark:border-card relative z-1 aspect-video h-[min(95vw,480px)] w-[100%] shrink-0 overflow-hidden rounded-[calc(var(--radius)+2px)] border-5 shadow-sm">
                <InteractiveDemo
                  gradientbg={false}
                  tab={false}
                  className="w-full max-w-full"
                  contentClassName="max-w-full mx-0 md:p-0 lg:p-0 p-0 "
                  innerClassName="border-none shadow-none bg-primary dark:bg-card rounded-none"
                  aside={false}
                />
              </div>
            </div>
          </div>
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
            <div className="mb-12 max-w-2xl">
              <Eyebrow>{tHome('workforceMapEyebrow')}</Eyebrow>
              <h2 className="mt-3 text-3xl font-medium text-balance md:text-4xl lg:tracking-tight">
                {tHome('workforceMapTitle')}
              </h2>
              <p className="text-muted-foreground mt-4 text-base text-balance">
                {tHome('workforceMapDescription')}
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <section className="flex flex-col items-center gap-5 pb-24 md:gap-0">
              <div className="relative grid w-full grid-cols-2 gap-5 md:grid-cols-4">
                {WORKFORCE_MAP_CAPABILITIES.map(({ icon: Icon, titleKey, descKey }) => (
                  <div
                    key={titleKey}
                    className="group border-border bg-card hover:bg-background flex w-full flex-col justify-between gap-4 rounded-sm border p-4 shadow-sm transition md:aspect-[283/200]"
                  >
                    <div className="bg-secondary group-hover:bg-card self-start rounded-lg p-2.5">
                      <Icon className="text-foreground size-5 shrink-0" />
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <p className="text-body-emphasis text-foreground transition">
                        {tHome(titleKey)}
                      </p>
                      <p className="text-body-sm text-muted-foreground transition">
                        {tHome(descKey)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              <svg
                viewBox="0 0 956 54"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                className="text-border mx-auto hidden max-w-[956px] md:block"
              >
                <defs>
                  <linearGradient id="flow" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--kortix-blue)" />
                    <stop offset="100%" stopColor="var(--background)" />
                  </linearGradient>

                  <linearGradient id="reveal" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="white" stopOpacity="0" />
                    <stop offset="45%" stopColor="white" stopOpacity="1" />
                    <stop offset="55%" stopColor="white" stopOpacity="1" />
                    <stop offset="100%" stopColor="white" stopOpacity="0" />
                    <animateTransform
                      attributeName="gradientTransform"
                      type="translate"
                      from="0 -1"
                      to="0 1"
                      dur="2.5s"
                      repeatCount="indefinite"
                    />
                  </linearGradient>

                  <mask id="mask">
                    <rect width="956" height="54" fill="url(#reveal)" />
                  </mask>
                </defs>

                {PATHS.map((d, i) => (
                  <path
                    key={`b${i}`}
                    d={d}
                    stroke="currentColor"
                    strokeOpacity="0.5"
                    strokeWidth="2"
                  />
                ))}

                <g mask="url(#mask)">
                  {PATHS.map((d, i) => (
                    <path key={`g${i}`} d={d} stroke="url(#flow)" strokeWidth="2" />
                  ))}
                </g>
              </svg>

              <div className="text-body-sm relative mx-auto grid w-full max-w-[856px] grid-flow-col-dense grid-cols-3 grid-rows-2 items-center gap-2 md:mx-auto md:flex md:w-auto md:flex-row md:gap-5">
                {WORKFORCE_MAP_DOMAINS.slice(0, 2).map(({ icon: Icon, labelKey }) => (
                  <div
                    key={labelKey}
                    className="group bg-card text-foreground border-border flex h-[46px] items-center justify-center gap-0.5 rounded-sm border px-6 py-3 transition md:gap-2"
                  >
                    <Icon className="size-4 shrink-0" />
                    <p>{tHome(labelKey)}</p>
                  </div>
                ))}

                <div className="group text-foreground bg-foreground row-span-2 flex h-full w-full flex-col items-center justify-center gap-0.5 rounded-sm px-6 py-3 transition hover:brightness-90 md:h-[64px] md:w-[105px] md:gap-2">
                  <KortixLogo className="text-background" />
                </div>

                {WORKFORCE_MAP_DOMAINS.slice(2, 4).map(({ icon: Icon, labelKey }) => (
                  <div
                    key={labelKey}
                    className="group bg-card text-foreground border-border flex h-[46px] items-center justify-center gap-0.5 rounded-sm border px-6 py-3 transition md:gap-2"
                  >
                    <Icon className="size-4 shrink-0" />
                    <p>{tHome(labelKey)}</p>
                  </div>
                ))}

                {/* <div className="absolute top-1/2 left-0 z-[-1] hidden h-[2px] w-full -translate-y-1/2 md:block">
                  <div className="bg-border absolute inset-0 opacity-50" />
                  <div className="horizontal-sweep absolute top-0 left-1/2 h-full -translate-x-1/2" />
                </div> */}
                <div className="bg-border absolute top-1/2 left-0 z-[-1] hidden h-[2px] w-full md:block"></div>
              </div>
            </section>
          </Reveal>
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
