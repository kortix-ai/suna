'use client';

import { useMemo, useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { Search, ArrowRight, Play, Check, Sparkles, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Reveal } from '@/components/home/reveal';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

const DEMO_URL = '/enterprise';
const START_URL = '/auth';
// Synthetic placeholder demo video — swap for a real per-agent clip later.
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

const TOTAL_AGENTS = INDUSTRIES.reduce((sum, ind) => sum + ind.agents.length, 0);
const FILTERS = ['All', ...INDUSTRIES.map((i) => i.name)];

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

/* ─── Synthetic, same-meaning breakdown content per agent ─── */
function buildBreakdown(agent: Agent, industry: string) {
  const lc = agent.description.charAt(0).toLowerCase() + agent.description.slice(1);
  const lname = agent.name.toLowerCase();
  return {
    overview: `The ${agent.name} agent handles ${lc} for ${industry} teams — end to end. It pulls context from your connected systems, plans the work, executes across your tools in a secure sandbox, and returns a finished, reviewable deliverable. It runs on a schedule or on demand, and gets sharper with every run.`,
    steps: [
      { t: 'Connect the context', d: `Pulls the data, documents, and tools the ${lname} workflow depends on — with permissioned access only.` },
      { t: 'Plan the work', d: 'Breaks the goal into a verifiable task list and selects the right skills and tools.' },
      { t: 'Execute in a sandbox', d: 'Works across your systems in an isolated environment, with every action logged.' },
      { t: 'Return for review', d: 'Hands back a finished deliverable with a traceable trail; a human approves before anything ships.' },
    ],
    inputs: ['Your connected data & documents', 'Existing templates & standards', 'A goal in plain language'],
    outputs: [`A finished ${lname} deliverable`, 'A reviewable run log with sources', 'A reusable skill saved to your repo'],
    integrations: ['gmail.com', 'slack.com', 'drive.google.com', 'github.com', 'notion.so'],
    prompt: `${agent.description} for our ${industry.toLowerCase()} team, and prepare it for review.`,
    highlights: ['Hours, not weeks', 'Fully traceable', 'On your standards'],
  };
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">{children}</span>;
}

/* ─── Agent video-preview card ─── */
function AgentCard({ agent, industry, onOpen }: { agent: Agent; industry: string; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="group text-left rounded-2xl border border-border bg-card/40 overflow-hidden hover:border-foreground/30 hover:shadow-lg transition-all cursor-pointer">
      <div className="relative aspect-video overflow-hidden bg-muted/30">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={posterFor(industry + agent.name)} alt={agent.name} className="absolute inset-0 w-full h-full object-cover object-top transition-transform duration-700 group-hover:scale-[1.04]" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent opacity-60 group-hover:opacity-80 transition-opacity" />
        <div className="absolute top-2.5 left-2.5 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-black/50 backdrop-blur-sm text-[10px] font-mono uppercase tracking-wider text-white/90">
          <Play className="size-2.5 fill-current" /> Preview
        </div>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="flex items-center justify-center size-11 rounded-full bg-white/90 text-black shadow-lg transition-transform group-hover:scale-110">
            <Play className="size-4 fill-current ml-0.5" />
          </span>
        </div>
      </div>
      <div className="p-4">
        <h3 className="text-sm font-semibold text-foreground">{agent.name}</h3>
        <p className="mt-1 text-[13px] text-muted-foreground leading-relaxed">{agent.description}</p>
      </div>
    </button>
  );
}

export default function UseCasesPage() {
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('All');
  const [selected, setSelected] = useState<Selected | null>(null);
  const [playing, setPlaying] = useState(false);

  const open = useCallback((agent: Agent, industry: string) => {
    setSelected({ ...agent, industry });
    setPlaying(false);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return INDUSTRIES.map((industry) => {
      if (activeFilter !== 'All' && industry.name !== activeFilter) return { ...industry, agents: [] as Agent[] };
      if (!q) return industry;
      const agents = industry.agents.filter((a) => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q));
      return { ...industry, agents };
    }).filter((industry) => industry.agents.length > 0);
  }, [query, activeFilter]);

  const matchedAgents = filtered.reduce((sum, ind) => sum + ind.agents.length, 0);
  const isDefault = activeFilter === 'All' && query.trim() === '';

  // Flat ordered list of the currently-visible agents, for prev/next browsing.
  const flatAgents = useMemo(
    () => filtered.flatMap((ind) => ind.agents.map((a) => ({ ...a, industry: ind.name } as Selected))),
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
    <div className="relative bg-background">
      <div className="pt-28 sm:pt-32">

        {/* ═══════════════ HERO ═══════════════ */}
        <section className="max-w-6xl mx-auto px-6 py-14 sm:py-20">
          <Reveal>
            <div className="max-w-3xl">
              <Eyebrow>Agent library</Eyebrow>
              <h1 className="mt-3 text-3xl sm:text-4xl md:text-5xl font-medium tracking-tight text-foreground leading-tight">
                An agent for every job on your plate.
              </h1>
              <p className="mt-4 text-base sm:text-lg text-muted-foreground leading-relaxed max-w-2xl">
                Each one comes ready for your industry, plugs into the tools you already run, and is doing real work within days — no multi-quarter rollout.
              </p>
            </div>
          </Reveal>
        </section>

        {/* ═══════════════ SEARCH + FILTER + GRID ═══════════════ */}
        <section className="max-w-6xl mx-auto px-6 py-14 sm:py-20 border-t border-border/50">
          <Reveal>
            <div className="relative max-w-xl">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder='Search agents — try "contract review"'
                className="w-full h-12 pl-11 pr-4 rounded-full border border-border bg-card/40 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-foreground/30 transition-colors"
              />
            </div>
          </Reveal>

          <Reveal delay={0.05}>
            <div className="mt-5 flex flex-wrap gap-2">
              {FILTERS.map((filter) => {
                const active = activeFilter === filter;
                return (
                  <button
                    key={filter}
                    onClick={() => setActiveFilter(filter)}
                    className={cn(
                      'px-4 h-9 rounded-full text-[13px] font-medium transition-colors cursor-pointer',
                      active ? 'bg-foreground text-background' : 'border border-border text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {filter}
                  </button>
                );
              })}
            </div>
          </Reveal>

          <Reveal delay={0.1}>
            <p className="mt-6 text-[13px] text-muted-foreground">
              {isDefault ? `${TOTAL_AGENTS} agents across ${INDUSTRIES.length} industries` : `${matchedAgents} ${matchedAgents === 1 ? 'agent' : 'agents'}`}
            </p>
          </Reveal>

          <div className="mt-10 space-y-14">
            {filtered.length === 0 ? (
              <Reveal>
                <p className="text-sm text-muted-foreground">No agents match your search. Try a different term or filter.</p>
              </Reveal>
            ) : (
              filtered.map((industry) => (
                <Reveal key={industry.name}>
                  <div>
                    <div className="flex items-baseline gap-3 flex-wrap">
                      <h2 className="text-xl sm:text-2xl font-medium tracking-tight text-foreground">{industry.name}</h2>
                      <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                        {industry.agents.length} {industry.agents.length === 1 ? 'agent' : 'agents'}
                      </span>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground leading-relaxed max-w-3xl">{industry.description}</p>
                    <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                      {industry.agents.map((agent) => (
                        <AgentCard key={agent.name} agent={agent} industry={industry.name} onOpen={() => open(agent, industry.name)} />
                      ))}
                    </div>
                  </div>
                </Reveal>
              ))
            )}
          </div>
        </section>

        {/* ═══════════════ DEPLOY IN DAYS ═══════════════ */}
        <section className="max-w-6xl mx-auto px-6 py-14 sm:py-20 border-t border-border/50">
          <Reveal>
            <div className="max-w-2xl">
              <Eyebrow>Live in days</Eyebrow>
              <h2 className="mt-3 text-2xl sm:text-3xl md:text-4xl font-medium tracking-tight text-foreground leading-tight">From first call to first result in a week.</h2>
              <p className="mt-4 text-base text-muted-foreground leading-relaxed max-w-xl">Spin up a workspace, connect your tools, and hand an agent a real task. That&apos;s the whole rollout.</p>
            </div>
          </Reveal>
        </section>

        {/* ═══════════════ FINAL CTA ═══════════════ */}
        <section className="max-w-5xl mx-auto px-6 py-20 sm:py-28 text-center border-t border-border/50">
          <Reveal>
            <h2 className="text-2xl sm:text-3xl md:text-4xl font-medium tracking-tight text-foreground leading-tight">Put one to work this week.</h2>
            <p className="mt-4 text-base text-muted-foreground leading-relaxed max-w-xl mx-auto">Start free, or have us tailor an agent to your workflow in a live demo.</p>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
              <Button asChild size="lg" className="h-12 px-8 text-sm rounded-full">
                <Link href={DEMO_URL}>Request demo<ArrowRight className="ml-1.5 size-3.5" /></Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="h-12 px-7 text-sm rounded-full">
                <Link href={START_URL}>Get started</Link>
              </Button>
            </div>
          </Reveal>
        </section>
      </div>

      {/* ═══════════════ AGENT BREAKDOWN MODAL ═══════════════ */}
      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        {selected && breakdown && (
          <DialogContent className="max-w-4xl p-0 gap-0 overflow-hidden max-h-[92vh] overflow-y-auto">
            {/* Video */}
            <div className="relative aspect-video bg-black">
              {playing ? (
                <iframe
                  src={`https://www.youtube.com/embed/${DEMO_VIDEO_ID}?autoplay=1&rel=0`}
                  title={`${selected.name} demo`}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  className="absolute inset-0 w-full h-full"
                />
              ) : (
                <button onClick={() => setPlaying(true)} className="group absolute inset-0 w-full h-full cursor-pointer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={posterFor(selected.industry + selected.name)} alt={selected.name} className="absolute inset-0 w-full h-full object-cover object-top" />
                  <div className="absolute inset-0 bg-black/30 group-hover:bg-black/40 transition-colors" />
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className="flex items-center justify-center size-16 rounded-full bg-white/95 text-black shadow-2xl transition-transform group-hover:scale-110">
                      <Play className="size-6 fill-current ml-1" />
                    </span>
                  </span>
                </button>
              )}
            </div>

            {/* Breakdown */}
            <div className="p-6 sm:p-8">
              {/* Prev / next browsing */}
              <div className="flex items-center justify-between mb-5">
                <span className="text-[12px] text-muted-foreground tabular-nums">
                  {(currentIndex >= 0 ? currentIndex + 1 : 1)} / {flatAgents.length}
                </span>
                <div className="flex items-center gap-2">
                  <button onClick={() => go(-1)} aria-label="Previous use-case" className="flex items-center justify-center size-9 rounded-full border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors cursor-pointer">
                    <ChevronLeft className="size-4" />
                  </button>
                  <button onClick={() => go(1)} aria-label="Next use-case" className="flex items-center justify-center size-9 rounded-full border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors cursor-pointer">
                    <ChevronRight className="size-4" />
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">{selected.industry}</span>
                <span className="size-1 rounded-full bg-muted-foreground/40" />
                <span className="inline-flex items-center gap-1 text-[11px] font-mono uppercase tracking-wider text-emerald-600 dark:text-emerald-500"><Sparkles className="size-3" />Pre-built agent</span>
              </div>
              <DialogTitle className="mt-2 text-2xl sm:text-3xl font-medium tracking-tight text-foreground">{selected.name}</DialogTitle>
              <p className="mt-1 text-sm text-muted-foreground">{selected.description}</p>

              <div className="mt-3 flex flex-wrap gap-2">
                {breakdown.highlights.map((h) => (
                  <span key={h} className="px-2.5 py-1 rounded-full border border-border bg-card/60 text-[12px] text-foreground">{h}</span>
                ))}
              </div>

              <p className="mt-6 text-[15px] text-muted-foreground leading-relaxed">{breakdown.overview}</p>

              {/* How it works */}
              <div className="mt-8">
                <h4 className="text-sm font-semibold text-foreground mb-4">How it works</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {breakdown.steps.map((s, i) => (
                    <div key={s.t} className="rounded-2xl border border-border bg-card/40 p-4">
                      <div className="text-[11px] font-mono text-muted-foreground">/0{i + 1}</div>
                      <div className="mt-1.5 text-sm font-semibold text-foreground">{s.t}</div>
                      <p className="mt-1 text-[13px] text-muted-foreground leading-relaxed">{s.d}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Inputs / Outputs */}
              <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div>
                  <h4 className="text-sm font-semibold text-foreground mb-3">What it needs</h4>
                  <ul className="space-y-2">
                    {breakdown.inputs.map((x) => (
                      <li key={x} className="flex items-start gap-2.5 text-[13px] text-muted-foreground"><Check className="size-4 mt-0.5 text-foreground/60 shrink-0" />{x}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-foreground mb-3">What you get back</h4>
                  <ul className="space-y-2">
                    {breakdown.outputs.map((x) => (
                      <li key={x} className="flex items-start gap-2.5 text-[13px] text-muted-foreground"><Check className="size-4 mt-0.5 text-emerald-500 shrink-0" />{x}</li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* Sample prompt */}
              <div className="mt-8">
                <h4 className="text-sm font-semibold text-foreground mb-3">Kick it off</h4>
                <div className="rounded-2xl border border-border bg-foreground/[0.03] p-4 font-mono text-[13px] text-foreground leading-relaxed">
                  <span className="text-muted-foreground select-none">&gt; </span>{breakdown.prompt}
                </div>
              </div>

              {/* Integrations */}
              <div className="mt-8">
                <h4 className="text-sm font-semibold text-foreground mb-3">Connects to</h4>
                <div className="flex flex-wrap items-center gap-2">
                  {breakdown.integrations.map((d) => (
                    <span key={d} className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-card/60">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={favicon(d)} alt={d} width={16} height={16} className="size-4 rounded-sm" />
                      <span className="text-[13px] text-foreground">{d.replace(/\.(com|so|google\.com|app)$/, '').replace('drive.', 'Drive')}</span>
                    </span>
                  ))}
                  <span className="text-[12px] text-muted-foreground">+ 3,000 more</span>
                </div>
              </div>

              {/* CTA */}
              <div className="mt-9 flex flex-col sm:flex-row gap-3 pt-6 border-t border-border/50">
                <Button asChild size="lg" className="h-12 px-7 text-sm rounded-full">
                  <Link href={DEMO_URL}>Request a demo of this agent<ArrowRight className="ml-1.5 size-3.5" /></Link>
                </Button>
                <Button asChild size="lg" variant="outline" className="h-12 px-7 text-sm rounded-full">
                  <Link href={START_URL}>Get started free</Link>
                </Button>
              </div>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
