'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { BackgroundAALChecker } from '@/components/auth/background-aal-checker';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { ArrowRight, Check, Github, Star, GitBranch, ShieldCheck, Box, KeyRound, ScrollText, Users, Server } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { useAuth } from '@/components/AuthProvider';
import { useGitHubStars } from '@/hooks/utils/use-github-stars';
import { Reveal } from '@/components/home/reveal';
import { InteractiveDemo } from '@/components/home/interactive-demo';
import { CodeWindow } from '@/components/home/code-window';

const DEMO_URL = '/enterprise';
const GITHUB_URL = 'https://github.com/kortix-ai/suna';
const favicon = (d: string) => `https://www.google.com/s2/favicons?domain=${d}&sz=128`;

// A big, recognizable slice of the 3,000+ connectors (favicons via Google's
// service). Grouped by category for readability — order doesn't matter, it all
// scrolls past in one continuous row below.
const INTEGRATIONS = [
  // Communication & email
  'gmail.com', 'slack.com', 'discord.com', 'zoom.us', 'microsoft.com', 'telegram.org',
  'whatsapp.com', 'twilio.com', 'sendgrid.com', 'mailgun.com', 'intercom.com', 'front.com',
  'loom.com', 'webex.com', 'ringcentral.com',
  // Productivity & docs
  'notion.so', 'airtable.com', 'asana.com', 'monday.com', 'clickup.com', 'trello.com',
  'todoist.com', 'evernote.com', 'coda.io', 'atlassian.com', 'jira.com', 'basecamp.com',
  'miro.com', 'figma.com', 'canva.com', 'smartsheet.com', 'wrike.com',
  // Files & storage
  'dropbox.com', 'box.com', 'drive.google.com', 'onedrive.live.com', 'wetransfer.com',
  // Dev & cloud
  'github.com', 'gitlab.com', 'bitbucket.org', 'vercel.com', 'netlify.com', 'heroku.com',
  'aws.amazon.com', 'cloud.google.com', 'azure.microsoft.com', 'digitalocean.com',
  'cloudflare.com', 'docker.com', 'sentry.io', 'datadoghq.com', 'pagerduty.com',
  'circleci.com', 'npmjs.com', 'postman.com', 'mongodb.com', 'redis.io', 'supabase.com',
  'planetscale.com', 'snowflake.com', 'databricks.com', 'jenkins.io', 'linear.app',
  // CRM & sales
  'salesforce.com', 'hubspot.com', 'pipedrive.com', 'zoho.com', 'close.com', 'outreach.io',
  'salesloft.com', 'gong.io', 'apollo.io', 'clearbit.com', 'zoominfo.com', 'copper.com',
  // Marketing
  'mailchimp.com', 'klaviyo.com', 'marketo.com', 'activecampaign.com', 'convertkit.com',
  'hootsuite.com', 'buffer.com', 'sproutsocial.com', 'semrush.com', 'ahrefs.com',
  'mixpanel.com', 'amplitude.com', 'segment.com', 'hotjar.com',
  // Payments & finance
  'stripe.com', 'paypal.com', 'squareup.com', 'quickbooks.intuit.com', 'xero.com', 'brex.com',
  'ramp.com', 'wise.com', 'plaid.com', 'chargebee.com', 'recurly.com', 'paddle.com', 'bill.com',
  // Support
  'zendesk.com', 'freshdesk.com', 'helpscout.com', 'gorgias.com', 'kustomer.com',
  // HR & recruiting
  'workday.com', 'bamboohr.com', 'gusto.com', 'rippling.com', 'deel.com', 'lever.co',
  'greenhouse.io', 'ashbyhq.com',
  // E-commerce & website
  'shopify.com', 'woocommerce.com', 'bigcommerce.com', 'squarespace.com', 'wix.com',
  'webflow.com', 'magento.com',
  // Data & BI
  'tableau.com', 'looker.com', 'metabase.com', 'fivetran.com', 'getdbt.com', 'hex.tech',
  // Forms, scheduling & automation
  'typeform.com', 'surveymonkey.com', 'jotform.com', 'tally.so', 'calendly.com', 'cal.com',
  'zapier.com', 'make.com', 'ifttt.com', 'retool.com', 'docusign.com', 'pandadoc.com',
  // Social
  'linkedin.com', 'x.com', 'facebook.com', 'instagram.com', 'youtube.com', 'tiktok.com',
  'reddit.com', 'pinterest.com', 'twitch.tv',
  // AI
  'openai.com', 'anthropic.com', 'huggingface.co', 'perplexity.ai', 'mistral.ai',
  'cohere.com', 'replicate.com', 'elevenlabs.io',
];

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">{children}</span>;
}

/**
 * One seamless, infinitely-looping logo row. Renders two identical copies and
 * scrolls by exactly one copy (50%) before wrapping, so there's never a blank
 * gap or a reset jump. Spacing lives on the items (mr-3), not the container, so
 * both copies are the same width and the wrap is pixel-perfect.
 */
// Calm, premium drift speed (px/sec). Each tile is 48px wide + 12px margin = 60px.
const MARQUEE_PX_PER_SEC = 28;

function LogoMarquee({ items, reverse = false }: { items: string[]; reverse?: boolean }) {
  // Constant on-screen speed regardless of how many logos are in the list.
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
              <span key={`${copy}-${d}-${i}`} className="mr-3 flex size-12 shrink-0 items-center justify-center rounded-2xl border border-border/60 bg-card">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={favicon(d)} alt="" width={22} height={22} loading="lazy" decoding="async" className="size-[22px] rounded-md" />
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
    <BackgroundAALChecker>
      <div className="relative bg-background">

        {/* ═══════════════ HERO + DEMO ═══════════════ */}
        <section className="relative overflow-hidden px-6 pt-32 pb-12 sm:pt-36">
          <div className="absolute inset-0 z-0"><WallpaperBackground wallpaperId="brandmark" /></div>

          {/* hero copy */}
          <div className="relative z-10 mx-auto flex max-w-3xl flex-col items-center text-center">
            <h1 className="text-4xl font-medium leading-[1.04] tracking-tight text-foreground sm:text-5xl md:text-6xl">
              {tHardcodedUi.raw('appHomePage.line138JsxTextTheAICommandCenter')}<br />
              <span className="text-muted-foreground">{tHardcodedUi.raw('appHomePage.line139JsxTextForYourCompany')}</span>
            </h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
              {tHardcodedUi.raw('appHomePage.line142JsxTextRunYourCompanyOnAIEveryAgentTrigger')}</p>
            <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
              <Button size="lg" className="h-12 rounded-full px-8 text-sm" onClick={handleLaunch}>
                {tHardcodedUi.raw('appHomePage.line146JsxTextGetStarted')}<ArrowRight className="ml-1.5 size-3.5" />
              </Button>
              <Button asChild size="lg" variant="outline" className="h-12 rounded-full px-7 text-sm">
                <Link href={DEMO_URL}>{tHardcodedUi.raw('appHomePage.line149JsxTextTalkToSales')}</Link>
              </Button>
            </div>
          </div>

          {/* interactive product demo */}
          <div id="demo" className="relative z-10 mt-14 scroll-mt-24 sm:mt-20">
            <InteractiveDemo />
          </div>
        </section>

        {/* ═══════════════ INTEGRATIONS MARQUEE ═══════════════ */}
        <section className="border-y border-border/60 bg-muted/20 py-10">
          <p className="mb-7 text-center text-sm text-muted-foreground">
            {tHardcodedUi.raw('appHomePage.line163JsxTextConnectsToThe')}<span className="font-medium text-foreground">{tHardcodedUi.raw('appHomePage.line163JsxText3000Apps')}</span> {tHardcodedUi.raw('appHomePage.line163JsxTextYourCompanyAlreadyRunsOn')}</p>
          <LogoMarquee items={INTEGRATIONS} />
        </section>

        {/* ═══════════════ STATS ═══════════════ */}
        <section className="mx-auto max-w-6xl px-6 py-16 sm:py-20">
          <Reveal>
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border/60 bg-border/60 lg:grid-cols-4">
              {[
                ['3,000+', 'Integrations, out of the box'],
                ['1', 'Command center for everything'],
                ['24/7', 'Agents that never clock out'],
                ['100%', 'Open & self-hostable'],
              ].map(([stat, label]) => (
                <div key={label} className="bg-card/40 px-6 py-8 text-center sm:py-10">
                  <div className="text-3xl font-medium tracking-tight text-foreground sm:text-4xl">{stat}</div>
                  <div className="mt-2 text-sm text-muted-foreground">{label}</div>
                </div>
              ))}
            </div>
          </Reveal>
        </section>

        {/* ═══════════════ ROLLOUT ═══════════════ */}
        <section className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
          <Reveal>
            <div className="mb-14 max-w-2xl">
              <Eyebrow>Rollout</Eyebrow>
              <h2 className="mt-3 text-2xl font-medium leading-tight tracking-tight text-foreground sm:text-3xl md:text-4xl">
                {tHardcodedUi.raw('appHomePage.line193JsxTextLiveAcrossYourCompanyInWeeks')}</h2>
              <p className="mt-4 text-base leading-relaxed text-muted-foreground">
                {tHardcodedUi.raw('appHomePage.line196JsxTextNoRipAndReplaceStandUpYourFirst')}</p>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="relative grid grid-cols-1 gap-10 sm:grid-cols-2 lg:grid-cols-4">
              <div className="absolute left-0 right-0 top-5 hidden h-px bg-border/70 lg:block" />
              {[
                { n: '1', t: 'Set up your workspace', d: 'Create a project and invite your teams, with roles and access from day one.' },
                { n: '2', t: 'Connect everything', d: 'Plug in the 3,000+ tools you already run, ready for agents to use.' },
                { n: '3', t: 'Build your agents', d: 'Turn your real processes into agents and skills that work the way you do.' },
                { n: '4', t: 'Roll out by department', d: 'Go team by team — sales, finance, ops, support — and scale what works.' },
              ].map(({ n, t, d }) => (
                <div key={n} className="relative">
                  <div className="flex size-10 items-center justify-center rounded-full border border-border bg-background text-sm font-semibold text-foreground">
                    {n}
                  </div>
                  <h3 className="mt-5 text-base font-semibold text-foreground">{t}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{d}</p>
                </div>
              ))}
            </div>
          </Reveal>
        </section>

        {/* ═══════════════ TECH — OPEN & CODE-NATIVE ═══════════════ */}
        <section className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
          <Reveal>
            <div className="mb-12 max-w-2xl">
              <Eyebrow>{tHardcodedUi.raw('appHomePage.line225JsxTextOpenCodeNative')}</Eyebrow>
              <h2 className="mt-3 text-2xl font-medium leading-tight tracking-tight text-foreground sm:text-3xl md:text-4xl">
                {tHardcodedUi.raw('appHomePage.line227JsxTextYourWholeCompanyAsCode')}</h2>
              <p className="mt-4 text-base leading-relaxed text-muted-foreground">
                {tHardcodedUi.raw('appHomePage.line230JsxTextEveryAgentSkillTriggerAndPolicyIsPlain')}<span className="font-medium text-foreground">opencode</span> {tHardcodedUi.raw('appHomePage.line230JsxTextAgentRuntimeSelfHostAnywhereNoBlackBox')}</p>
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
                    ['kortix.toml declares triggers, channels, connectors, and the sandbox — versioned from the first commit.'],
                    ['Agents and skills are markdown under .opencode/ — edit and ship them like any codebase.'],
                    ['Every change is a git commit: open a PR, review the diff, roll back instantly.'],
                    ['Self-host on your own infra, or run on Kortix cloud — bring your own models either way.'],
                  ].map(([x]) => (
                    <li key={x} className="flex items-start gap-3 text-sm leading-relaxed text-muted-foreground">
                      <Check className="mt-0.5 size-4 shrink-0 text-foreground/70" />{x}
                    </li>
                  ))}
                </ul>

                {/* GitHub stars / social proof */}
                <a
                  href={GITHUB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group mt-7 flex items-center gap-3 rounded-2xl border border-border/60 bg-card p-4 transition-colors hover:border-foreground/30"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/40">
                    <Github className="size-5 text-foreground/80" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                      <Star className="size-3.5 fill-current text-amber-500" />
                      {formattedStars} {tHardcodedUi.raw('appHomePage.line267JsxTextStarsOnGitHub')}</div>
                    <div className="mt-0.5 text-sm text-muted-foreground">{tHardcodedUi.raw('appHomePage.line269JsxTextALeadingOpenSourceAIWorkspace')}</div>
                  </div>
                  <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-all group-hover:translate-x-0.5 group-hover:text-foreground" />
                </a>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ═══════════════ ENTERPRISE — SECURITY & CONTROL ═══════════════ */}
        <section className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
          <Reveal>
            <div className="mb-12 max-w-2xl">
              <Eyebrow>Enterprise</Eyebrow>
              <h2 className="mt-3 text-2xl font-medium leading-tight tracking-tight text-foreground sm:text-3xl md:text-4xl">
                {tHardcodedUi.raw('appHomePage.line284JsxTextSecureEnoughToRunTheWholeCompany')}</h2>
              <p className="mt-4 text-base leading-relaxed text-muted-foreground">
                {tHardcodedUi.raw('appHomePage.line287JsxTextFineGrainedControlOverWhoAndWhichAgent')}</p>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-border/60 bg-border/60 sm:grid-cols-2 lg:grid-cols-3">
              {[
                { icon: Users, t: 'RBAC & roles', d: 'Members, groups, and roles. Every permission scoped to people and agents alike.' },
                { icon: ShieldCheck, t: 'Executor policies', d: 'Guardrails on every action — require a human to approve anything risky or over-limit.' },
                { icon: Box, t: 'Isolated sandboxes', d: 'Each session runs in its own secure, ephemeral sandbox. No shared state, no blast radius.' },
                { icon: KeyRound, t: 'Secrets vault', d: 'Credentials encrypted at rest, injected at runtime, never exposed to the model or logs.' },
                { icon: ScrollText, t: 'Audit & approvals', d: 'A complete, immutable trail of every action, decision, and human approval gate.' },
                { icon: Server, t: 'On-prem & VPC', d: 'Deploy in your own cloud, VPC, or air-gapped. Your data never leaves your perimeter.' },
              ].map(({ icon: Icon, t, d }) => (
                <div key={t} className="bg-card/40 p-6">
                  <span className="flex size-10 items-center justify-center rounded-xl border border-border bg-muted/40">
                    <Icon className="size-5 text-foreground/80" />
                  </span>
                  <h3 className="mt-4 text-base font-semibold text-foreground">{t}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{d}</p>
                </div>
              ))}
            </div>
          </Reveal>
          <Reveal delay={0.15}>
            <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2">
              <Link href={DEMO_URL} className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground transition-all hover:gap-2.5">
                {tHardcodedUi.raw('appHomePage.line314JsxTextTalkToSales')}<ArrowRight className="size-4" />
              </Link>
              <Link href="/technology" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
                {tHardcodedUi.raw('appHomePage.line317JsxTextSeeHowItWorks')}</Link>
            </div>
          </Reveal>
        </section>

        {/* ═══════════════ FINAL CTA ═══════════════ */}
        <section className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
          <Reveal>
            <div className="relative overflow-hidden rounded-[28px] border border-border bg-card px-6 py-20 text-center sm:py-28">
              <div className="absolute inset-0 z-0 opacity-50"><WallpaperBackground wallpaperId="brandmark" /></div>
              <div className="relative z-10">
                <Eyebrow>{tHardcodedUi.raw('appHomePage.line329JsxTextGetStarted')}</Eyebrow>
                <h2 className="mx-auto mt-3 max-w-2xl text-3xl font-medium leading-tight tracking-tight text-foreground sm:text-4xl md:text-5xl">
                  {tHardcodedUi.raw('appHomePage.line331JsxTextGiveYourCompanyAWorkforce')}</h2>
                <p className="mx-auto mt-4 max-w-xl text-base text-muted-foreground sm:text-lg">
                  {tHardcodedUi.raw('appHomePage.line334JsxTextFreeToSelfHostManagedCloudFrom20')}</p>
                <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                  <Button size="lg" className="h-12 rounded-full px-8 text-sm" onClick={handleLaunch}>{tHardcodedUi.raw('appHomePage.line337JsxTextGetStarted')}<ArrowRight className="ml-1.5 size-3.5" /></Button>
                  <Button asChild size="lg" variant="outline" className="h-12 rounded-full px-7 text-sm"><Link href={DEMO_URL}>{tHardcodedUi.raw('appHomePage.line338JsxTextTalkToSales')}</Link></Button>
                  <Button asChild size="lg" variant="ghost" className="h-12 rounded-full px-7 text-sm"><Link href="/pricing">{tHardcodedUi.raw('appHomePage.line339JsxTextSeePricing')}</Link></Button>
                </div>
                <p className="mt-7 inline-flex items-center gap-2 text-xs text-muted-foreground">
                  <GitBranch className="size-3.5" /> {tHardcodedUi.raw('appHomePage.line342JsxTextOpenSourceSSORBACOnPremNoLock')}</p>
              </div>
            </div>
          </Reveal>
        </section>

        <div className="h-24 sm:h-28" />

        {/* ═══════════════ FLOATING CTA BAR ═══════════════ */}
        <div className={cn('fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-background/95 px-1.5 py-1.5 backdrop-blur-md transition-[transform,opacity] duration-[600ms] ease-[cubic-bezier(0.32,0.72,0,1)] will-change-transform', showFloatingCta ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-16 opacity-0')}>
          <Link href="/technology" className="hidden h-8 items-center rounded-full px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:flex">Technical</Link>
          <span className="hidden h-5 w-px bg-border sm:block" />
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="flex size-8 items-center justify-center rounded-full transition-colors hover:bg-foreground/[0.08]"><Github className="size-4" /></a>
          <Button size="sm" className="rounded-full px-5 text-xs font-medium" onClick={handleLaunch}>{tHardcodedUi.raw('appHomePage.line356JsxTextGetStarted')}<ArrowRight className="ml-1.5 size-3" /></Button>
        </div>
      </div>
    </BackgroundAALChecker>
  );
}
