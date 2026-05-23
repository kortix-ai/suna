'use client';

import { useTranslations } from 'next-intl';

import { useRef } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowUpRight } from 'lucide-react';
import { motion, useInView } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';

const stackStudies = [
  {
    id: '01',
    name: 'Architecture First',
    thesis: 'Best when the homepage needs to explain the system clearly.',
    rows: [
      ['Agents, skills, tools, MCP, browser', 'The visible surface area'],
      ['Kortix orchestration', 'Memory, integrations, scheduling, tunnels'],
      ['OpenCode engine', 'Sessions, execution, context, recovery'],
      ['Linux machine', 'Filesystem, bash, Chromium, Git, SSH'],
    ],
  },
  {
    id: '02',
    name: 'State First',
    thesis: 'Best when the core message is that everything lives on the machine.',
    rows: [
      ['All state on the computer', 'Sessions, memory, credentials, projects'],
      ['Kortix keeps it organized', 'Cron, routing, memory, integrations'],
      ['OpenCode runs the agent', 'Tool calls, context injection, recovery'],
      ['Linux stores it in /workspace', 'One persistent volume, one machine'],
    ],
  },
  {
    id: '03',
    name: 'Operational Flow',
    thesis: 'Best when the page needs to feel active and execution-oriented.',
    rows: [
      ['Signal', 'Human requests, cron, Slack, email'],
      ['Kortix', 'Routes intent and keeps memory coherent'],
      ['OpenCode', 'Plans, calls tools, manages session state'],
      ['Tools', 'Browser, shell, CLI, MCP, direct API'],
      ['Filesystem', 'Logs, state, code, artifacts, memory'],
    ],
  },
];

const filesystemProof = [
  '/workspace/.local/share/opencode/storage/session',
  '/workspace/.local/share/opencode/storage/message',
  '/workspace/.local/share/opencode/storage/kortix-memory.db',
  '/workspace/.opencode/agents',
  '/workspace/.opencode/skills',
  '/workspace/.secrets',
  '/workspace/.browser-profile',
  '/workspace/<projects>',
];

const copyLines = [
  'A Linux computer with an AI workforce inside.',
  'Everything the agent learns stays on the machine.',
  'OpenCode is the engine. The filesystem is the state.',
  'One computer for sessions, memories, credentials, and code.',
  'Connect your tools once. The computer keeps running.',
];

const integrations = [
  ['Gmail', 'OAuth'],
  ['Slack', 'OAuth'],
  ['GitHub', 'CLI + API'],
  ['Notion', 'MCP'],
  ['HubSpot', 'MCP / API'],
  ['Finance systems', 'API / files / browser'],
];

function Reveal({
  children,
  delay = 0,
}: {
  children: React.ReactNode;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: '-80px' });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 24 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.55, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}

function SectionLabel({ label }: { label: string }) {
  return (
    <div className="mb-5 flex items-center gap-4">
      <span className="text-xs uppercase tracking-[0.28em] text-muted-foreground">
        {label}
      </span>
      <div className="h-px flex-1 bg-border/50" />
    </div>
  );
}

function StudyCard({
  id,
  name,
  thesis,
  rows,
}: {
  id: string;
  name: string;
  thesis: string;
  rows: string[][];
}) {
  return (
    <article className="rounded-[28px] border border-border/60 bg-background/80 p-6 shadow-[0_24px_80px_rgba(0,0,0,0.05)] backdrop-blur-xl sm:p-7">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-muted-foreground">
            Study {id}
          </p>
          <h2 className="mt-2 text-2xl font-medium tracking-tight text-foreground">
            {name}
          </h2>
        </div>
        <span className="rounded-full border border-border/60 px-3 py-1 text-xs uppercase tracking-[0.2em] text-muted-foreground">
          Candidate
        </span>
      </div>

      <p className="mb-6 max-w-xl text-sm leading-relaxed text-muted-foreground">
        {thesis}
      </p>

      <div className="overflow-hidden rounded-2xl border border-border/50 bg-muted/18">
        {rows.map(([title, detail], index) => (
          <div
            key={title}
            className="grid gap-1 border-t border-border/45 px-5 py-4 first:border-t-0 sm:grid-cols-[1.15fr_0.85fr] sm:items-center"
          >
            <p className="text-sm font-medium text-foreground">{title}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{detail}</p>
          </div>
        ))}
      </div>
    </article>
  );
}

function NotebookBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[24px] border border-border/55 bg-background/78 p-5 backdrop-blur-xl sm:p-6">
      <p className="mb-4 text-xs uppercase tracking-[0.24em] text-muted-foreground">
        {title}
      </p>
      {children}
    </section>
  );
}

export default function ExplorationPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="relative min-h-screen overflow-hidden bg-background">
      <WallpaperBackground />

      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.8),transparent_42%),linear-gradient(180deg,rgba(255,255,255,0.72),rgba(255,255,255,0.92))] dark:bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.06),transparent_30%),linear-gradient(180deg,rgba(0,0,0,0.18),rgba(0,0,0,0.56))]" />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: 'url(/grain-texture.png)',
          backgroundRepeat: 'repeat',
          backgroundSize: '80px 80px',
        }}
      />

      <div className="relative z-10 mx-auto max-w-7xl px-6 pb-24 pt-10 sm:px-8 sm:pt-14">
        <Reveal>
          <div className="mb-12 flex items-center justify-between gap-4">
            <Button asChild variant="ghost" className="-ml-3 rounded-full text-muted-foreground">
              <Link href="/">
                <ArrowLeft className="mr-2 size-4" />
                Home
              </Link>
            </Button>
          </div>
        </Reveal>

        <div className="grid gap-10 xl:grid-cols-[minmax(0,1.25fr)_360px]">
          <div>
            <Reveal delay={0.03}>
              <p className="text-xs uppercase tracking-[0.32em] text-muted-foreground">
                Exploration
              </p>
              <h1 className="mt-4 max-w-4xl text-4xl font-medium tracking-tight text-foreground sm:text-5xl md:text-6xl">{tHardcodedUi.raw('appHomeExplorationPage.line205JsxTextACalmerWayToEvaluateHowKortixShould')}</h1>
              <p className="mt-5 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-sm">{tHardcodedUi.raw('appHomeExplorationPage.line208JsxTextThisPageIsAWorkingWallArchitectureStudies')}</p>
            </Reveal>

            <div className="mt-14 space-y-10">
              <Reveal delay={0.06}>
                <SectionLabel label={tHardcodedUi.raw('appHomeExplorationPage.line216JsxAttrLabelStackStudies')} />
              </Reveal>

              <div className="space-y-6">
                {stackStudies.map((study, index) => (
                  <Reveal key={study.id} delay={0.08 + index * 0.05}>
                    <StudyCard {...study} />
                  </Reveal>
                ))}
              </div>

              <Reveal delay={0.06}>
                <SectionLabel label={tHardcodedUi.raw('appHomeExplorationPage.line228JsxAttrLabelProofElements')} />
              </Reveal>

              <div className="grid gap-6 lg:grid-cols-2">
                <Reveal delay={0.1}>
                  <NotebookBlock title="Filesystem">
                    <div className="rounded-2xl border border-border/45 bg-muted/18 p-5 font-mono text-xs leading-loose text-muted-foreground">
                      {filesystemProof.map((item) => (
                        <div key={item}>{item}</div>
                      ))}
                    </div>
                  </NotebookBlock>
                </Reveal>

                <Reveal delay={0.14}>
                  <NotebookBlock title={tHardcodedUi.raw('appHomeExplorationPage.line243JsxAttrTitleMemoryModel')}>
                    <div className="rounded-2xl border border-border/45 bg-muted/18 p-5">
                      <div className="flex flex-wrap gap-2 text-xs font-mono text-muted-foreground">
                        {['tool call', 'observation', 'consolidation', 'long-term memory', 'future context'].map(
                          (item, index) => (
                            <div key={item} className="flex items-center gap-2">
                              <span className="rounded-full border border-border/50 px-3 py-1">
                                {item}
                              </span>
                              {index < 4 ? <span className="text-muted-foreground">{'->'}</span> : null}
                            </div>
                          )
                        )}
                      </div>
                      <div className="mt-5 space-y-2 text-sm text-muted-foreground">
                        <p><span className="text-foreground">Episodic</span>{tHardcodedUi.raw('appHomeExplorationPage.line258JsxTextWhatHappenedAndWhen')}</p>
                        <p><span className="text-foreground">Semantic</span>{tHardcodedUi.raw('appHomeExplorationPage.line259JsxTextFactsSystemsStructure')}</p>
                        <p><span className="text-foreground">Procedural</span>{tHardcodedUi.raw('appHomeExplorationPage.line260JsxTextWorkflowsAndHowToKnowledge')}</p>
                      </div>
                    </div>
                  </NotebookBlock>
                </Reveal>
              </div>

              <Reveal delay={0.06}>
                <SectionLabel label="Language" />
              </Reveal>

              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <Reveal delay={0.1}>
                  <NotebookBlock title={tHardcodedUi.raw('appHomeExplorationPage.line273JsxAttrTitlePositioningLines')}>
                    <div className="space-y-3">
                      {copyLines.map((line) => (
                        <div
                          key={line}
                          className="rounded-2xl border border-border/45 bg-muted/14 px-4 py-3 text-sm leading-relaxed text-foreground"
                        >
                          {line}
                        </div>
                      ))}
                    </div>
                  </NotebookBlock>
                </Reveal>

                <Reveal delay={0.14}>
                  <NotebookBlock title={tHardcodedUi.raw('appHomeExplorationPage.line288JsxAttrTitleIntegrationSurface')}>
                    <div className="rounded-2xl border border-border/45 bg-muted/18 p-5 font-mono text-xs leading-loose text-muted-foreground">
                      {integrations.map(([name, method]) => (
                        <div key={name} className="flex items-start justify-between gap-4 border-t border-border/35 py-2 first:border-t-0 first:pt-0 last:pb-0">
                          <span className="text-foreground">{name}</span>
                          <span className="text-muted-foreground">{method}</span>
                        </div>
                      ))}
                    </div>
                  </NotebookBlock>
                </Reveal>
              </div>
            </div>
          </div>

          <div>
            <Reveal delay={0.08}>
              <div className="xl:sticky xl:top-24 space-y-6">
                <NotebookBlock title={tHardcodedUi.raw('appHomeExplorationPage.line306JsxAttrTitleEditorialRead')}>
                  <div className="space-y-4 text-sm leading-relaxed text-muted-foreground">
                    <p>
                      <span className="text-foreground">{tHardcodedUi.raw('appHomeExplorationPage.line309JsxTextBestHomepageAnchor')}</span>{' '}{tHardcodedUi.raw('appHomeExplorationPage.line310JsxTextStateFirstItGetsToTheRealDifferentiator')}</p>
                    <p>
                      <span className="text-foreground">{tHardcodedUi.raw('appHomeExplorationPage.line313JsxTextBestSupportingProof')}</span>{' '}{tHardcodedUi.raw('appHomeExplorationPage.line314JsxTextFilesystemMemoryThoseTwoMakeTheIdeaFeel')}</p>
                    <p>
                      <span className="text-foreground">{tHardcodedUi.raw('appHomeExplorationPage.line317JsxTextDesignDirection')}</span>{' '}{tHardcodedUi.raw('appHomeExplorationPage.line318JsxTextQuieterMoreEditorialLessProductDemoEnergy')}</p>
                  </div>
                </NotebookBlock>

                <NotebookBlock title={tHardcodedUi.raw('appHomeExplorationPage.line323JsxAttrTitleRecommendedHomepageMix')}>
                  <ol className="space-y-3 text-sm leading-relaxed text-muted-foreground">
                    <li>{tHardcodedUi.raw('appHomeExplorationPage.line325JsxTextText1LeadWithASingleStackGraphic')}</li>
                    <li>{tHardcodedUi.raw('appHomeExplorationPage.line326JsxTextText2FollowWithOneFilesystemProofBlock')}</li>
                    <li>{tHardcodedUi.raw('appHomeExplorationPage.line327JsxTextText3AddOneLineAboutMemoryAndOne')}</li>
                    <li>{tHardcodedUi.raw('appHomeExplorationPage.line328JsxTextText4KeepThePageEmotionallyCalmAndTechnically')}</li>
                  </ol>
                </NotebookBlock>

                <NotebookBlock title={tHardcodedUi.raw('appHomeExplorationPage.line332JsxAttrTitleNextMove')}>
                  <Button asChild className="w-full rounded-full shadow-none">
                    <Link href="/">{tHardcodedUi.raw('appHomeExplorationPage.line335JsxTextBringTheBestStudyBackHome')}<ArrowUpRight className="ml-2 size-4" />
                    </Link>
                  </Button>
                </NotebookBlock>
              </div>
            </Reveal>
          </div>
        </div>
      </div>
    </div>
  );
}
