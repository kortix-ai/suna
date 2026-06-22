'use client';

import { Reveal } from '@/components/home/reveal';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { AnimatedThinkingText } from '@/components/ui/animated-thinking-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  AtSign,
  BarChart3,
  BellRing,
  BookOpenText,
  Brain,
  Building2,
  ChartNoAxesCombined,
  CheckCircle2,
  ClipboardList,
  GitPullRequest,
  KeyRound,
  MoreHorizontal,
  Plus,
  Server,
  ShieldCheck,
  Smile,
} from 'lucide-react';
import { AnimatePresence, motion, useInView } from 'motion/react';
import { useTranslations } from 'next-intl';
import Image from 'next/image';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../icon/icon';

const sectionShell = 'mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0';

function SectionIntro({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="mb-12 max-w-2xl space-y-3">
      {/* <p className="text-muted-foreground font-mono text-xs tracking-wider uppercase">{eyebrow}</p> */}
      <Badge variant="kortix" className="rounded">
        {eyebrow}
      </Badge>
      <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">{title}</h2>
      <p className="text-muted-foreground text-base leading-relaxed">{description}</p>
    </div>
  );
}

const skillBullets = [
  'storySkillsBulletCapture',
  'storySkillsBulletReuse',
  'storySkillsBulletReview',
];

const memoryBullets = [
  'storyMemoryBulletContext',
  'storyMemoryBulletLearning',
  'storyMemoryBulletGrounded',
];

export function SkillsSection() {
  const tHome = useTranslations('hardcodedUi.appHomePage');

  return (
    <section className={sectionShell}>
      <Reveal>
        <div className="border-border bg-card grid overflow-hidden rounded-sm border lg:grid-cols-12">
          <div className="border-border border-b p-6 md:p-8 lg:col-span-12 lg:p-10">
            <Badge variant="kortix" className="rounded">
              {tHome('storySkillsEyebrow')}
            </Badge>
            <h2 className="text-foreground mt-4 text-3xl font-medium tracking-tight sm:text-4xl">
              {tHome('storySkillsTitle')}
            </h2>
            <p className="text-muted-foreground mt-4 text-base leading-relaxed">
              {tHome('storySkillsDescription')}
            </p>
          </div>
          <div className="bg-border grid gap-px lg:col-span-12 lg:grid-cols-3">
            {skillBullets.map((bulletKey) => (
              <div key={bulletKey} className="bg-card p-6 md:p-8">
                <h3 className="text-foreground text-lg font-medium tracking-tight">
                  {tHome(bulletKey)}
                </h3>
                <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
                  {tHome('storySkillsBulletDescription')}
                </p>
              </div>
            ))}
          </div>
        </div>
      </Reveal>
    </section>
  );
}

export function MemorySection() {
  const tHome = useTranslations('hardcodedUi.appHomePage');

  return (
    <section className={sectionShell}>
      <Reveal>
        <div className="grid gap-10 lg:grid-cols-12 lg:items-center">
          <div className="lg:col-span-5">
            <SectionIntro
              eyebrow={tHome('storyMemoryEyebrow')}
              title={tHome('storyMemoryTitle')}
              description={tHome('storyMemoryDescription')}
            />
          </div>
          <div className="border-border bg-card grid overflow-hidden rounded-sm border lg:col-span-7">
            {memoryBullets.map((bulletKey, index) => (
              <div
                key={bulletKey}
                className={cn('flex gap-4 p-6 md:p-7', index > 0 && 'border-border border-t')}
              >
                <Brain className="text-kortix-purple mt-1 size-5 shrink-0" />
                <div>
                  <h3 className="text-foreground text-lg font-medium tracking-tight">
                    {tHome(bulletKey)}
                  </h3>
                  <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
                    {tHome('storyMemoryBulletDescription')}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Reveal>
    </section>
  );
}

// TODO: replace with the live Kortix Slack / Microsoft Teams app-install URLs.
const SLACK_INSTALL_URL = 'https://slack.com/apps';
const TEAMS_INSTALL_URL = 'https://appsource.microsoft.com';

const surfaceCards = [
  {
    key: 'slack',
    href: SLACK_INSTALL_URL,
    icon: Icon.Slack,
    person: 'Maya',
    initial: 'M',
    accent: 'bg-[#4A154B]/[0.04] dark:bg-[#4A154B]/20',
    name: 'storySurfaceSlackTitle',
    value: 'storySurfaceSlackBody',
    ask: 'storySurfaceSlackAsk',
    reply: 'storySurfaceSlackReply',
    deliverable: 'storySurfaceSlackDeliverable',
    cta: 'storySurfaceSlackCta',
  },
  {
    key: 'teams',
    href: TEAMS_INSTALL_URL,
    icon: Icon.MicrosoftTeams,
    person: 'Alex',
    initial: 'A',
    accent: 'bg-[#5059C9]/[0.05] dark:bg-[#5059C9]/20',
    name: 'storySurfaceTeamsTitle',
    value: 'storySurfaceTeamsBody',
    ask: 'storySurfaceTeamsAsk',
    reply: 'storySurfaceTeamsReply',
    deliverable: 'storySurfaceTeamsDeliverable',
    cta: 'storySurfaceTeamsCta',
  },
] as const;

const bubbleTransition = (delay: number) => ({
  duration: 0.25,
  ease: [0.16, 1, 0.3, 1] as const,
  delay,
});

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
  const tI18nHardcoded = useTranslations('hardcodedUi');
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
          statusText={tI18nHardcoded.raw(
            'autoFeaturesMarketingStorySectionsJsxAttrStatusTextGatheringOvernightUpdates3a9550bf',
          )}
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

function SlackChatMessage({
  children,
  name,
  isApp = false,
  avatar,
}: {
  children: ReactNode;
  name: string;
  isApp?: boolean;
  avatar: ReactNode;
}) {
  const dateLabel = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: 'easeIn' }}
      className="flex w-full flex-row items-start justify-start gap-2"
    >
      {avatar}
      <div className="flex min-w-0 flex-1 flex-col gap-0">
        <div className="flex flex-row items-center justify-start gap-1">
          <span className="text-foreground block truncate text-xs font-semibold">{name}</span>
          {isApp ? (
            <span className="bg-muted rounded-[0.2rem] px-1 py-[0.04rem] text-[7px]">APP</span>
          ) : null}
          <span className="text-[9px]">{dateLabel}</span>
        </div>
        <div className="text-muted-foreground text-xs font-medium">{children}</div>
      </div>
    </motion.div>
  );
}

function SlackSurfaceCard({
  card: _card,
  index: _index,
}: {
  card: (typeof surfaceCards)[number];
  index: number;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const chatRef = useRef<HTMLDivElement>(null);
  const isChatInView = useInView(chatRef, { once: true, amount: 0.4 });
  const [visibleChatMessages, setVisibleChatMessages] = useState(0);

  useEffect(() => {
    if (!isChatInView) return;

    setVisibleChatMessages(1);
    const secondMessageTimer = window.setTimeout(() => setVisibleChatMessages(2), 2000);
    const thirdMessageTimer = window.setTimeout(() => setVisibleChatMessages(3), 4000);

    return () => {
      window.clearTimeout(secondMessageTimer);
      window.clearTimeout(thirdMessageTimer);
    };
  }, [isChatInView]);

  return (
    <div className="bg-card flex h-full w-full flex-col overflow-hidden rounded-md">
      <div
        className={cn(
          'border-border relative flex-1 grow border-b bg-[linear-gradient(in_oklch_180deg,oklch(from_var(--kortix-blue)_l_c_h/0.3)_0%,oklch(from_var(--kortix-green)_l_c_h/0.3)_33%,oklch(from_var(--kortix-yellow)_l_c_h/0.3)_66%,oklch(from_var(--kortix-red)_l_c_h/0.3)_100%)] p-5 pb-0 md:p-6 md:pb-0',
        )}
      >
        <div className="bg-background flex h-full w-full flex-1 grow flex-col rounded-t-lg border">
          <div className="flex items-center justify-between border-b-[1.5px] px-5 py-3.5">
            <div className="flex items-center justify-center gap-4">
              <Icon.Slack className="size-6" />
              <span className="text-foreground text-lg font-semibold">Kortix</span>
            </div>
            <div>
              <Button variant="ghost" size="icon-sm" aria-label="More options">
                <MoreHorizontal />
              </Button>
            </div>
          </div>

          <div
            ref={chatRef}
            className="flex min-h-[280px] flex-1 flex-col justify-end space-y-3 overflow-hidden p-4"
          >
            <AnimatePresence initial={false}>
              {visibleChatMessages >= 1 ? (
                <SlackChatMessage
                  key="chat-message-1"
                  name="Kortix"
                  isApp
                  avatar={
                    <span className="bg-primary flex size-[2.1rem] shrink-0 items-center justify-center rounded-md">
                      <KortixLogo size={16} className="text-background" />
                    </span>
                  }
                >
                  <span className="block truncate">
                    {tI18nHardcoded.raw(
                      'autoFeaturesMarketingStorySectionsJsxTextHeyWhatCanI5de80837',
                    )}
                  </span>
                </SlackChatMessage>
              ) : null}

              {visibleChatMessages >= 2 ? (
                <SlackChatMessage
                  key="chat-message-2"
                  name="Marko"
                  avatar={
                    <span className="bg-primary relative flex size-[2.1rem] shrink-0 items-center justify-center overflow-hidden rounded-md">
                      <Image
                        src="https://ke4pydspzeg0nm0o.public.blob.vercel-storage.com/marko.png"
                        alt="Marko Kraemer"
                        className="size-full"
                        fill
                      />
                    </span>
                  }
                >
                  <span className="block truncate">
                    {tI18nHardcoded.raw(
                      'autoFeaturesMarketingStorySectionsJsxTextWhatHappenedWhileIb8835287',
                    )}
                  </span>
                </SlackChatMessage>
              ) : null}

              {visibleChatMessages >= 3 ? (
                <SlackChatMessage
                  key="chat-message-3"
                  name="Kortix"
                  isApp
                  avatar={
                    <span className="bg-primary flex size-[2.1rem] shrink-0 items-center justify-center rounded-md">
                      <KortixLogo size={16} className="text-background" />
                    </span>
                  }
                >
                  <ChatMorningBriefReply />
                </SlackChatMessage>
              ) : null}
            </AnimatePresence>

            <div className="border-border bg-card w-full shrink-0 rounded-(--radius-lg) border">
              <div className="px-3 py-2">
                <Textarea
                  minHeight={20}
                  maxHeight={10}
                  placeholder={tI18nHardcoded.raw(
                    'autoFeaturesMarketingStorySectionsJsxAttrPlaceholderTypeYourMessage95756d48',
                  )}
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
      </div>

      {/* <div className="mt-auto flex flex-col p-5 md:p-6">
        <p className="text-muted-foreground text-sm leading-relaxed">{tHome(card.value)}</p>
        <Button asChild variant="outline" size="lg" className="mt-5 w-full active:scale-[0.99]">
          <a href={card.href} target="_blank" rel="noreferrer">
            <BrandIcon className="size-4" />
            {tHome(card.cta)}
          </a>
        </Button>
      </div> */}
    </div>
  );
}

function TeamsSurfaceCard({
  card,
  index: _index,
}: {
  card: (typeof surfaceCards)[number];
  index: number;
}) {
  const tHome = useTranslations('hardcodedUi.appHomePage');

  return (
    <div className="bg-card flex h-full w-full flex-col overflow-hidden rounded-md">
      <div
        className={cn(
          'border-border from-kortix-purple/30 via-kortix-blue/30 relative w-full flex-1 grow border-b bg-linear-180 to-transparent p-5 pb-0 md:p-6 md:pb-0',
        )}
      >
        <div className="bg-background flex h-full w-full flex-1 grow flex-col rounded-t-lg border">
          <div className="flex items-center justify-between border-b px-5 py-3.5">
            <div className="flex items-center justify-center gap-4">
              <Icon.MicrosoftTeams className="size-6" />
              <span className="text-foreground text-lg font-semibold">Kortix</span>
            </div>
            <div>
              <Button variant="ghost" size="icon-sm" aria-label="More options">
                <MoreHorizontal />
              </Button>
            </div>
          </div>

          <div className="relative flex min-h-[280px] flex-1 flex-col items-center justify-center overflow-hidden p-6 text-center">
            <div className="relative z-10 flex w-full max-w-xs flex-col items-center gap-3">
              <Badge variant="kortix" className="rounded">
                {tHome('storySurfaceTeamsComingSoon')}
              </Badge>
              <p className="text-muted-foreground text-sm leading-relaxed">{tHome(card.value)}</p>
              <Button
                variant="outline"
                size="lg"
                className="mt-2 w-full"
                disabled
                title={tHome('storySurfaceTeamsComingSoon')}
              >
                <Icon.MicrosoftTeams className="size-4" />
                {tHome('storySurfaceTeamsComingSoon')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SurfacesSection() {
  const tHome = useTranslations('hardcodedUi.appHomePage');

  return (
    <section className={sectionShell}>
      <Reveal>
        <SectionIntro
          eyebrow={tHome('storySurfacesEyebrow')}
          title={tHome('storySurfacesTitle')}
          description={tHome('storySurfacesDescription')}
        />
        <div className="grid aspect-video h-full grid-cols-1 gap-4 md:grid-cols-12">
          {surfaceCards.map((card, index) =>
            card.key === 'slack' ? (
              <div key={card.key} className="lg:col-span-8">
                <SlackSurfaceCard card={card} index={index} />
              </div>
            ) : (
              <div key={card.key} className="hidden lg:col-span-4 lg:block">
                <TeamsSurfaceCard card={card} index={index} />
              </div>
            ),
          )}
        </div>
      </Reveal>
    </section>
  );
}

const outcomes = [
  {
    title: 'storyOutcomeBoardTitle',
    body: 'storyOutcomeBoardBody',
    icon: ClipboardList,
  },
  {
    title: 'storyOutcomeReportsTitle',
    body: 'storyOutcomeReportsBody',
    icon: BarChart3,
  },
  {
    title: 'storyOutcomeSalesTitle',
    body: 'storyOutcomeSalesBody',
    icon: Building2,
  },
  {
    title: 'storyOutcomeToolsTitle',
    body: 'storyOutcomeToolsBody',
    icon: ChartNoAxesCombined,
  },
  {
    title: 'storyOutcomeSupportTitle',
    body: 'storyOutcomeSupportBody',
    icon: CheckCircle2,
  },
  {
    title: 'storyOutcomeCodeTitle',
    body: 'storyOutcomeCodeBody',
    icon: GitPullRequest,
  },
];

export function OutcomeCardsSection() {
  const tHome = useTranslations('hardcodedUi.appHomePage');

  return (
    <section className={sectionShell}>
      <Reveal>
        <SectionIntro
          eyebrow={tHome('storyOutcomesEyebrow')}
          title={tHome('storyOutcomesTitle')}
          description={tHome('storyOutcomesDescription')}
        />
        <div className="bg-border grid gap-px overflow-hidden rounded-sm border md:grid-cols-2 lg:grid-cols-3">
          {outcomes.map(({ title, body, icon: Icon }) => (
            <div key={title} className="bg-card p-6">
              <Icon className="text-muted-foreground size-5" />
              <h3 className="text-foreground mt-6 text-lg font-medium tracking-tight">
                {tHome(title)}
              </h3>
              <p className="text-muted-foreground mt-3 text-sm leading-relaxed">{tHome(body)}</p>
            </div>
          ))}
        </div>
      </Reveal>
    </section>
  );
}

function DatabaseDot({ className }: { className?: string }) {
  return (
    <span className={cn('bg-card block size-2 rounded-full border border-current', className)} />
  );
}

const alwaysOnExamples = [
  'storyAlwaysOnExampleRevenue',
  'storyAlwaysOnExampleHealth',
  'storyAlwaysOnExampleSpend',
  'storyAlwaysOnExampleLead',
  'storyAlwaysOnExampleSupport',
];

export function AlwaysOnSection() {
  const tHome = useTranslations('hardcodedUi.appHomePage');

  return (
    <section className={sectionShell}>
      <Reveal>
        <div className="border-border bg-foreground text-background grid overflow-hidden rounded-sm border lg:grid-cols-12">
          <div className="p-6 md:p-8 lg:col-span-5 lg:p-10">
            <p className="text-background/70 font-mono text-xs tracking-wider uppercase">
              {tHome('storyAlwaysOnEyebrow')}
            </p>
            <h2 className="mt-4 text-3xl font-medium tracking-tight sm:text-4xl">
              {tHome('storyAlwaysOnTitle')}
            </h2>
            <p className="text-background/70 mt-4 text-base leading-relaxed">
              {tHome('storyAlwaysOnDescription')}
            </p>
          </div>
          <div className="bg-background/15 grid gap-px lg:col-span-7">
            {alwaysOnExamples.map((example, index) => (
              <div key={example} className="bg-foreground flex items-center gap-4 p-5 md:p-6">
                <BellRing className="text-kortix-yellow size-5 shrink-0" />
                <div className="font-mono text-sm tracking-wide">{tHome(example)}</div>
                <span className="text-background/45 ml-auto font-mono text-xs">0{index + 1}</span>
              </div>
            ))}
          </div>
        </div>
      </Reveal>
    </section>
  );
}

const ownership = [
  { label: 'storyOwnershipOpenSource', icon: BookOpenText },
  { label: 'storyOwnershipModels', icon: KeyRound },
  { label: 'storyOwnershipSelfHost', icon: Server },
  { label: 'storyOwnershipNoLockIn', icon: ShieldCheck },
];

export function OwnershipSection() {
  const tHome = useTranslations('hardcodedUi.appHomePage');

  return (
    <section className={sectionShell}>
      <Reveal>
        <SectionIntro
          eyebrow={tHome('storyOwnershipEyebrow')}
          title={tHome('storyOwnershipTitle')}
          description={tHome('storyOwnershipDescription')}
        />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {ownership.map(({ label, icon: Icon }) => (
            <div key={label} className="border-border bg-card rounded-sm border p-5">
              <Icon className="text-muted-foreground size-5" />
              <h3 className="text-foreground mt-5 text-base font-medium tracking-tight">
                {tHome(label)}
              </h3>
            </div>
          ))}
        </div>
      </Reveal>
    </section>
  );
}
