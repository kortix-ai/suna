'use client';

import { useAuth } from '@/components/AuthProvider';
import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetTitle } from '@/components/ui/sheet';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { Icon } from '@/features/icon/icon';
import { YOUTUBE_IFRAME_ALLOW } from '@/lib/security/iframe-sandbox';
import * as SheetPrimitive from '@radix-ui/react-dialog';
import { ArrowRight, Check, GitBranch, Play, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Image from 'next/image';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

const DEMO_URL = '/enterprise';
const START_URL = '/auth';
const DEMO_VIDEO_ID = 'Eu5mYMavctM';

type Agent = { name: string; description: string };
type Industry = { name: string; description: string; agents: Agent[] };
type Selected = Agent & { industry: string };

const INDUSTRIES: Industry[] = [
  {
    name: 'Software & SaaS',
    description:
      'Agents that live in your codebase, issue tracker, and support queue — shipping fixes, triaging bugs, and keeping docs honest.',
    agents: [
      { name: 'Bug triage', description: 'Reproduce, label, and route issues' },
      { name: 'PR review', description: 'First-pass review against your standards' },
      { name: 'Release notes', description: 'Draft changelogs from merged PRs' },
      { name: 'On-call assist', description: 'Summarize alerts and suggest a fix' },
      { name: 'Docs upkeep', description: 'Keep docs in sync with the code' },
      { name: 'Churn signals', description: 'Flag at-risk accounts from usage' },
      { name: 'Feature requests', description: 'Cluster feedback into themes' },
    ],
  },
  {
    name: 'E-commerce & Retail',
    description:
      'Agents across your storefront, catalog, and inbox — answering shoppers, fixing listings, and watching the numbers.',
    agents: [
      { name: 'Order support', description: 'Resolve where-is-my-order in seconds' },
      { name: 'Catalog cleanup', description: 'Fix titles, tags, and descriptions' },
      { name: 'Returns & refunds', description: 'Process within your policy' },
      { name: 'Pricing watch', description: 'Track competitors and margins' },
      { name: 'Review replies', description: 'Respond to reviews on brand' },
      { name: 'Restock alerts', description: 'Reorder before you sell out' },
      { name: 'Campaign recaps', description: 'Weekly performance, explained' },
    ],
  },
  {
    name: 'Marketing & Creative',
    description:
      'Agents that turn a brief into finished work — posts, pages, and assets, on brand and ready to ship.',
    agents: [
      { name: 'Content engine', description: 'Briefs into drafts and posts' },
      { name: 'SEO pages', description: 'Research, write, and interlink' },
      { name: 'Ad variations', description: 'On-brand copy and creative at scale' },
      { name: 'Social scheduling', description: 'Plan and post across channels' },
      { name: 'Campaign reporting', description: 'What worked, in plain English' },
      { name: 'Brand assets', description: 'Generate and edit visuals in-flow' },
    ],
  },
  {
    name: 'Sales & Revenue',
    description:
      'Agents that fill the pipeline and keep it clean — researching accounts, drafting outreach, and prepping every call.',
    agents: [
      { name: 'Lead research', description: 'Enrich and rank your accounts' },
      { name: 'Outreach drafts', description: 'Personalized, at scale' },
      { name: 'CRM hygiene', description: 'Keep records clean and current' },
      { name: 'Call prep', description: 'A brief before every meeting' },
      { name: 'Proposal drafts', description: 'Quotes and SOWs in minutes' },
      { name: 'Pipeline reports', description: 'Forecast and flag stalls' },
    ],
  },
  {
    name: 'Customer Support',
    description:
      'Agents on the front line — resolving tickets with full context, around the clock, and escalating only what matters.',
    agents: [
      { name: 'Ticket triage', description: 'Sort, tag, and route instantly' },
      { name: 'First response', description: 'Resolve common issues 24/7' },
      { name: 'Knowledge base', description: 'Draft and update help articles' },
      { name: 'Escalations', description: 'Hand off with full context' },
      { name: 'CSAT analysis', description: 'Spot themes in feedback' },
      { name: 'Saved replies', description: 'On-brand answers, every time' },
    ],
  },
  {
    name: 'Finance & Accounting',
    description:
      'Agents for the back office — reconciling, reporting, and closing the books with a trail you can audit.',
    agents: [
      { name: 'Invoice processing', description: 'Capture, match, and route' },
      { name: 'Reconciliation', description: 'Tie out accounts fast' },
      { name: 'Expense review', description: 'Flag policy exceptions' },
      { name: 'Board reporting', description: 'Consolidated and on time' },
      { name: 'Financial models', description: 'Forecasts and scenarios' },
      { name: 'AR follow-up', description: 'Chase invoices, politely' },
    ],
  },
  {
    name: 'People & Recruiting',
    description:
      'Agents for hiring and people ops — sourcing, screening, and onboarding handled, so your team can focus on people.',
    agents: [
      { name: 'Candidate sourcing', description: 'Find and rank matches' },
      { name: 'Resume screening', description: 'Shortlist against the role' },
      { name: 'Interview scheduling', description: 'Coordinate without the back-and-forth' },
      { name: 'Offer & onboarding', description: 'Draft offers, prep day one' },
      { name: 'HR answers', description: 'Answered from your handbook' },
      { name: 'Headcount reports', description: 'Pipeline and attrition' },
    ],
  },
  {
    name: 'Operations & Supply Chain',
    description:
      'Agents that keep the business running — turning orders, vendors, and SOPs into workflows that run themselves.',
    agents: [
      { name: 'Order tracking', description: 'Status across suppliers' },
      { name: 'Vendor management', description: 'Performance and contracts' },
      { name: 'Demand planning', description: 'Forecast and reorder' },
      { name: 'SOP automation', description: 'Turn playbooks into workflows' },
      { name: 'Quality checks', description: 'Log issues, open actions' },
      { name: 'Logistics', description: 'Shipments and exceptions' },
    ],
  },
  {
    name: 'Legal & Compliance',
    description:
      'Agents for review, research, and drafting — cited correctly, right for the jurisdiction, and reviewable end to end.',
    agents: [
      { name: 'Contract review', description: 'Your positions, their redlines' },
      { name: 'Legal research', description: 'Memos with citations' },
      { name: 'Document drafting', description: 'Briefs, motions, agreements' },
      { name: 'Diligence review', description: 'Transaction documents at speed' },
      { name: 'Policy tracking', description: 'Regulatory change, watched' },
      { name: 'E-discovery', description: 'Privilege and production prep' },
    ],
  },
  {
    name: 'Real Estate & Property',
    description:
      'Agents across listings, leads, and leases — drafting, qualifying, and keeping every deal moving.',
    agents: [
      { name: 'Listing copy', description: 'Photos and specs into listings' },
      { name: 'Lead qualification', description: 'Score and follow up fast' },
      { name: 'Comps & valuation', description: 'Pull comps, value a property' },
      { name: 'Lease abstraction', description: 'Key terms from any lease' },
      { name: 'Tenant requests', description: 'Triage and route maintenance' },
      { name: 'Closing checklist', description: 'Track docs to the finish' },
    ],
  },
];

const FILTERS = ['All', ...INDUSTRIES.map((i) => i.name)];

function agentMatchesQuery(industry: Industry, agent: Agent, words: string[]) {
  const haystack = [industry.name, industry.description, agent.name, agent.description].map((s) =>
    s.toLowerCase(),
  );
  return words.every((word) => haystack.some((text) => text.includes(word)));
}

const POSTERS = [
  '/showcase/data/dashboard.png',
  '/showcase/presentation/slide1.png',
  '/images/landing-showcase/data.png',
  '/images/landing-showcase/docs.png',
  '/images/landing-showcase/research.png',
  '/images/landing-showcase/slides.png',
  '/images/landing-showcase/images.png',
];

function posterFor(key: string) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return POSTERS[h % POSTERS.length];
}

const favicon = (domain: string) => `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;

function buildBreakdown(agent: Agent, industry: string) {
  const lc = agent.description.charAt(0).toLowerCase() + agent.description.slice(1);
  const lname = agent.name.toLowerCase();
  return {
    overview: `The ${agent.name} agent handles ${lc} for ${industry} teams — end to end. It pulls context from your connected systems, plans the work, executes across your tools in a secure sandbox, and returns a finished, reviewable deliverable. It runs on a schedule or on demand, and gets sharper with every run.`,
    steps: [
      {
        t: 'Connect the context',
        d: `Pulls the data, documents, and tools the ${lname} workflow depends on — with permissioned access only.`,
      },
      {
        t: 'Plan the work',
        d: 'Breaks the goal into a verifiable task list and selects the right skills and tools.',
      },
      {
        t: 'Execute in a sandbox',
        d: 'Works across your systems in an isolated environment, with every action logged.',
      },
      {
        t: 'Return for review',
        d: 'Hands back a finished deliverable with a traceable trail; a human approves before anything ships.',
      },
    ],
    inputs: [
      'Your connected data & documents',
      'Existing templates & standards',
      'A goal in plain language',
    ],
    outputs: [
      `A finished ${lname} deliverable`,
      'A reviewable run log with sources',
      'A reusable skill saved to your repo',
    ],
    integrations: ['gmail.com', 'slack.com', 'drive.google.com', 'github.com', 'notion.so'],
    prompt: `${agent.description} for our ${industry.toLowerCase()} team, and prepare it for review.`,
    highlights: ['Hours, not weeks', 'Fully traceable', 'On your standards'],
  };
}

function AgentCard({
  agent,
  industry,
  onOpen,
}: {
  agent: Agent;
  industry: string;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      className="group bg-muted dark:bg-muted/60 cursor-pointer overflow-hidden rounded p-2 text-left"
    >
      <div className="bg-muted/30 relative aspect-video overflow-hidden rounded-[calc(var(--spacing)*0.5)]">
        <Image
          src={posterFor(industry + agent.name)}
          alt={agent.name}
          fill
          sizes="(max-width: 768px) 100vw, 33vw"
          className="object-cover object-top"
        />
        <div className="absolute inset-0 bg-linear-0 from-black/40 to-transparent opacity-60 transition-opacity group-hover:from-black/30 group-hover:opacity-80" />
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="bg-primary text-background border-primary flex size-11 items-center justify-center rounded-full border">
            <Play className="size-4 fill-current" />
          </span>
        </div>
      </div>
      <div className="p-4 px-2 pb-2">
        <h3 className="text-foreground text-sm font-semibold">{agent.name}</h3>
        <p className="text-muted-foreground mt-1 text-sm leading-relaxed">{agent.description}</p>
      </div>
    </button>
  );
}

export default function UseCasesPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('All');
  const [selected, setSelected] = useState<Selected | null>(null);
  const [playing, setPlaying] = useState(false);
  const { user } = useAuth();

  const open = useCallback((agent: Agent, industry: string) => {
    setSelected({ ...agent, industry });
    setPlaying(false);
  }, []);

  const handleLaunch = useCallback(() => {
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  const filtered = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return INDUSTRIES.map((industry) => {
      if (activeFilter !== 'All' && industry.name !== activeFilter)
        return { ...industry, agents: [] as Agent[] };
      if (words.length === 0) return industry;
      const agents = industry.agents.filter((a) => agentMatchesQuery(industry, a, words));
      return { ...industry, agents };
    }).filter((industry) => industry.agents.length > 0);
  }, [query, activeFilter]);

  const flatAgents = useMemo(
    () =>
      filtered.flatMap((ind) => ind.agents.map((a) => ({ ...a, industry: ind.name }) as Selected)),
    [filtered],
  );
  const currentIndex = selected
    ? flatAgents.findIndex((a) => a.industry === selected.industry && a.name === selected.name)
    : -1;

  const go = useCallback(
    (dir: number) => {
      setSelected((cur) => {
        if (!cur || flatAgents.length === 0) return cur;
        const idx = flatAgents.findIndex((a) => a.industry === cur.industry && a.name === cur.name);
        if (idx < 0) return cur;
        return flatAgents[(idx + dir + flatAgents.length) % flatAgents.length];
      });
      setPlaying(false);
    },
    [flatAgents],
  );

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, go]);

  const breakdown = selected ? buildBreakdown(selected, selected.industry) : null;

  return (
    <div className="bg-background relative">
      <div className="pt-28 sm:pt-32">
        <section className="mx-auto max-w-5xl px-6 py-14 sm:py-20">
          <div className="mx-auto text-center">
            <h2 className="text-3xl font-medium text-balance md:text-4xl lg:text-5xl lg:tracking-tight">
              {tHardcodedUi.raw('appHomeUseCasesPage.line293JsxTextAnAgentForEveryJobOnYourPlate')}
            </h2>
            <p className="text-muted-foreground mx-auto mt-4 max-w-4xl text-lg text-balance">
              {tHardcodedUi.raw(
                'appHomeUseCasesPage.line296JsxTextEachOneComesReadyForYourIndustryPlugs',
              )}
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 pb-14 sm:pb-20">
          {/* <Reveal>
            <div className="relative max-w-xl">
              <Search className="text-muted-foreground absolute top-1/2 left-3.5 size-[1.1rem] -translate-y-1/2" />
              <Input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={tHardcodedUi.raw(
                  'appHomeUseCasesPage.line311JsxAttrPlaceholderSearchAgentsTryContractReview',
                )}
                className="pl-10"
                size="lg"
              />

              <Button
                variant="ghost"
                size="icon-sm"
                className={cn(
                  'absolute top-1/2 right-2 -translate-y-1/2 opacity-0 transition-opacity',
                  query && 'opacity-100',
                )}
                onClick={() => setQuery('')}
              >
                <Icon.Close />
              </Button>
            </div>
          </Reveal> */}

          <Reveal delay={0.05}>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              {FILTERS.map((filter) => {
                const active = activeFilter === filter;
                return (
                  <Button
                    key={filter}
                    size="xs"
                    variant={active ? 'secondary' : 'ghost'}
                    onClick={() => setActiveFilter(filter)}
                    className="rounded-full border capitalize"
                  >
                    {filter}
                  </Button>
                );
              })}
            </div>
          </Reveal>

          <div className="mt-10 space-y-14">
            {filtered.length === 0 ? (
              <Reveal>
                <p className="text-muted-foreground text-sm">
                  {tHardcodedUi.raw(
                    'appHomeUseCasesPage.line346JsxTextNoAgentsMatchYourSearchTryADifferent',
                  )}
                </p>
              </Reveal>
            ) : (
              filtered.map((industry) => (
                <Reveal key={industry.name}>
                  <div className="space-y-6">
                    <div className="space-y-1">
                      <h2 className="text-foreground text-xl font-medium tracking-tight sm:text-2xl">
                        {industry.name}
                      </h2>
                      <p className="text-muted-foreground max-w-3xl text-base">
                        {industry.description}
                      </p>
                    </div>
                    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                      {industry.agents.map((agent) => (
                        <AgentCard
                          key={agent.name}
                          agent={agent}
                          industry={industry.name}
                          onOpen={() => open(agent, industry.name)}
                        />
                      ))}
                    </div>
                  </div>
                </Reveal>
              ))
            )}
          </div>
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
                    <ArrowRight className="size-3.5" />
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
                    <ArrowRight className="size-3.5" />
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
      </div>

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        {selected && breakdown && (
          <SheetContent
            side="right"
            className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
          >
            <SheetBody className="relative p-0">
              <div className="relative aspect-video w-full shrink-0 border-b bg-black">
                {playing ? (
                  <iframe
                    src={`https://www.youtube.com/embed/${DEMO_VIDEO_ID}?autoplay=1&rel=0`}
                    title={`${selected.name} demo`}
                    allow={YOUTUBE_IFRAME_ALLOW}
                    allowFullScreen
                    className="absolute inset-0 h-full w-full"
                  />
                ) : (
                  <button
                    onClick={() => setPlaying(true)}
                    className="group absolute inset-0 h-full w-full cursor-pointer"
                  >
                    <Image
                      src={posterFor(selected.industry + selected.name)}
                      alt={selected.name}
                      fill
                      sizes="(max-width: 1024px) 100vw, 800px"
                      className="object-cover object-top"
                    />
                    <div className="absolute inset-0 bg-black/30 transition-colors group-hover:bg-black/40" />
                    <span className="absolute inset-0 flex items-center justify-center">
                      <span className="flex size-16 items-center justify-center rounded-full bg-white/95 text-black shadow-2xl transition-transform group-hover:scale-110">
                        <Play className="ml-1 size-6 fill-current" />
                      </span>
                    </span>
                  </button>
                )}
              </div>

              <div className="p-6 px-6 sm:px-8">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
                    {selected.industry}
                  </span>
                  <span className="bg-muted-foreground/40 size-1 rounded-full" />
                  <span className="inline-flex items-center gap-1 font-mono text-xs tracking-wider text-emerald-600 uppercase dark:text-emerald-500">
                    <Sparkles className="size-3" />
                    {tHardcodedUi.raw('appHomeUseCasesPage.line449JsxTextPreBuiltAgent')}
                  </span>
                </div>
                <SheetTitle className="text-foreground mt-2 text-2xl font-medium tracking-tight sm:text-3xl">
                  {selected.name}
                </SheetTitle>
                <p className="text-muted-foreground mt-1 text-sm">{selected.description}</p>

                <div className="mt-3 flex flex-wrap gap-2">
                  {breakdown.highlights.map((h) => (
                    <span
                      key={h}
                      className="border-border bg-card/60 text-foreground rounded-full border px-2.5 py-1 text-xs"
                    >
                      {h}
                    </span>
                  ))}
                </div>

                <p className="text-muted-foreground mt-6 text-sm leading-relaxed">
                  {breakdown.overview}
                </p>

                <div className="mt-8">
                  <h4 className="text-foreground mb-4 text-sm font-semibold">
                    {tHardcodedUi.raw('appHomeUseCasesPage.line464JsxTextHowItWorks')}
                  </h4>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {breakdown.steps.map((s, i) => (
                      <div key={s.t} className="border-border bg-card/40 rounded-sm border p-4">
                        <div className="text-muted-foreground font-mono text-xs">/0{i + 1}</div>
                        <div className="text-foreground mt-1.5 text-sm font-semibold">{s.t}</div>
                        <p className="text-muted-foreground mt-1 text-sm leading-relaxed">{s.d}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2">
                  <div>
                    <h4 className="text-foreground mb-3 text-sm font-semibold">
                      {tHardcodedUi.raw('appHomeUseCasesPage.line479JsxTextWhatItNeeds')}
                    </h4>
                    <ul className="space-y-2">
                      {breakdown.inputs.map((x) => (
                        <li
                          key={x}
                          className="text-muted-foreground flex items-start gap-2.5 text-sm"
                        >
                          <Check className="text-foreground/60 mt-0.5 size-4 shrink-0" />
                          {x}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h4 className="text-foreground mb-3 text-sm font-semibold">
                      {tHardcodedUi.raw('appHomeUseCasesPage.line487JsxTextWhatYouGetBack')}
                    </h4>
                    <ul className="space-y-2">
                      {breakdown.outputs.map((x) => (
                        <li
                          key={x}
                          className="text-muted-foreground flex items-start gap-2.5 text-sm"
                        >
                          <Check className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                          {x}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div className="mt-8">
                  <h4 className="text-foreground mb-3 text-sm font-semibold">
                    {tHardcodedUi.raw('appHomeUseCasesPage.line498JsxTextKickItOff')}
                  </h4>
                  <div className="border-border bg-foreground/[0.03] text-foreground rounded-sm border p-4 font-mono text-sm leading-relaxed">
                    <span className="text-muted-foreground select-none">
                      {tHardcodedUi.raw('appHomeUseCasesPage.line500JsxTextGt')}
                    </span>
                    {breakdown.prompt}
                  </div>
                </div>

                <div className="mt-8">
                  <h4 className="text-foreground mb-3 text-sm font-semibold">
                    {tHardcodedUi.raw('appHomeUseCasesPage.line506JsxTextConnectsTo')}
                  </h4>
                  <div className="flex flex-wrap items-center gap-2">
                    {breakdown.integrations.map((d) => (
                      <Badge variant="outline" className="px-2 py-3.5">
                        <img
                          src={favicon(d)}
                          alt={d}
                          width={16}
                          height={16}
                          className="size-4 rounded-sm"
                        />
                        <span className="text-foreground text-sm">
                          {d.replace(/\.(com|so|google\.com|app)$/, '').replace('drive.', 'Drive')}
                        </span>
                      </Badge>
                    ))}
                    <span className="text-muted-foreground text-sm">
                      {tHardcodedUi.raw('appHomeUseCasesPage.line515JsxTextText3000More')}
                    </span>
                  </div>
                </div>
              </div>
            </SheetBody>

            <SheetFooter className="gap-2 p-4 sm:justify-between">
              <Button asChild size="lg">
                <Link href={DEMO_URL}>
                  {tHardcodedUi.raw('appHomeUseCasesPage.line522JsxTextRequestADemoOfThisAgent')}
                  <ArrowRight className="ml-1.5 size-3.5" />
                </Link>
              </Button>
              <div className="flex items-center gap-2">
                <Button asChild size="lg" variant="secondary" className="w-full flex-1 md:w-auto">
                  <Link href={START_URL}>
                    {tHardcodedUi.raw('appHomeUseCasesPage.line525JsxTextGetStartedFree')}
                  </Link>
                </Button>
                <SheetPrimitive.Close className="block sm:hidden">
                  <Button size="icon" variant="secondary">
                    <Icon.Close />
                  </Button>
                </SheetPrimitive.Close>
              </div>
            </SheetFooter>
          </SheetContent>
        )}
      </Sheet>
    </div>
  );
}
