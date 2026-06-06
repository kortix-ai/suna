'use client';

import { useAuth } from '@/components/AuthProvider';
import { Reveal } from '@/components/home/reveal';
import { Button } from '@/components/ui/marketing/button';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import {
  agentMatchesQuery,
  FILTERS,
  INDUSTRIES,
  posterFor,
  slugFor,
  type Agent,
} from '@/features/use-cases/data';
import { ArrowRight, GitBranch, Play } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Image from 'next/image';
import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';

const DEMO_URL = '/enterprise';

function AgentCard({ agent, industry }: { agent: Agent; industry: string }) {
  return (
    <Link
      href={`/use-cases/${slugFor(industry, agent.name)}`}
      className="group bg-muted dark:bg-muted/60 cursor-pointer overflow-hidden rounded-2xl p-2 text-left"
    >
      <div className="bg-muted/30 relative aspect-video overflow-hidden rounded-xl">
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
    </Link>
  );
}

export default function UseCasesPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [query] = useState('');
  const [activeFilter, setActiveFilter] = useState('All');
  const { user } = useAuth();

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
                        <AgentCard key={agent.name} agent={agent} industry={industry.name} />
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
            <div className="border-border bg-card relative overflow-hidden rounded-2xl border px-6 py-20 text-center sm:py-28">
              <div className="absolute inset-0 z-0 mask-t-from-90% opacity-50">
                <WallpaperBackground wallpaperId="brandmark" />
              </div>
              <div className="relative z-10 mx-auto max-w-lg">
                <h2 className="text-foreground mx-auto mt-3 max-w-2xl text-3xl leading-tight font-medium tracking-tight sm:text-4xl md:text-5xl">
                  {tHardcodedUi.raw('appHomePage.line331JsxTextGiveYourCompanyAWorkforce')}
                </h2>
                <div className="text-muted-foreground mx-auto mt-4 max-w-2xl space-y-1 text-base text-balance sm:text-lg">
                  {(
                    tHardcodedUi.raw(
                      'appHomePage.line334JsxTextFreeToSelfHostManagedCloudFrom20',
                    ) as string[]
                  ).map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                </div>
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
    </div>
  );
}
