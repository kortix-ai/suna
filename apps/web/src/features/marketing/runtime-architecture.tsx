'use client';

import { Reveal } from '@/components/home/reveal';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Badge } from '@/components/ui/badge';
import type { LucideIcon } from 'lucide-react';
import { Bot, Code2, FileText, GitBranch, GitMerge, GitPullRequestArrow } from 'lucide-react';

// Match the marketing section rhythm of its neighbors (company-as-repo,
// use-cases-by-department): centered, max-w-6xl, same horizontal padding.
const sectionShell = 'mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0';

// 01 — the repo's files, the source of truth.
const FILES: { icon: LucideIcon; label: string; path: string }[] = [
  { icon: Bot, label: 'Agents', path: 'agents/*.md' },
  { icon: FileText, label: 'Context', path: 'memory/*.md · AGENTS.md' },
  { icon: Code2, label: 'Code', path: 'the codebase' },
];

// 02 — one task per branch, each in its own sandbox.
const BRANCHES = ['triage-tickets', 'build-board-deck', 'draft-outreach'];

/**
 * One equal-height step card. The big muted number + left→right order carry
 * the sequencing — there are no connector graphics between the cards.
 */
function StepCard({
  index,
  title,
  line,
  children,
}: {
  index: string;
  title: string;
  line: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-border bg-card flex h-full min-w-0 flex-col gap-5 rounded-2xl border p-6 sm:p-7">
      <span
        className="text-muted-foreground/25 font-mono text-4xl leading-none font-medium tabular-nums sm:text-5xl"
        aria-hidden
      >
        {index}
      </span>
      <div className="space-y-1.5">
        <h3 className="text-foreground text-base font-semibold tracking-tight text-balance">
          {title}
        </h3>
        <p className="text-muted-foreground text-sm leading-relaxed">{line}</p>
      </div>
      <div className="mt-auto">{children}</div>
    </div>
  );
}

/** 01 — a tidy mono file list: the repo as the source of truth. */
function RepoVisual() {
  return (
    <div className="border-border bg-background overflow-hidden rounded-2xl border">
      <div className="border-border/60 text-muted-foreground flex items-center gap-2 border-b px-4 py-2.5 font-mono text-xs">
        <GitMerge className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">your-company · main</span>
      </div>
      <div className="divide-border/60 divide-y">
        {FILES.map(({ icon: Icon, label, path }) => (
          <div key={label} className="flex items-center gap-3 px-4 py-3">
            <Icon className="text-muted-foreground size-4 shrink-0" />
            <span className="text-foreground w-16 shrink-0 text-sm font-medium">{label}</span>
            <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">{path}</span>
          </div>
        ))}
      </div>
      <p className="text-muted-foreground/80 border-border/60 border-t px-4 py-2.5 font-mono text-xs">
        one repo · main
      </p>
    </div>
  );
}

/** 02 — runtime label + a branch chip per task. */
function RuntimeVisual() {
  return (
    <div className="border-border bg-background overflow-hidden rounded-2xl border">
      <div className="border-border/60 flex items-center gap-2 border-b px-4 py-2.5">
        <span className="bg-foreground flex size-5 shrink-0 items-center justify-center rounded-md">
          <KortixLogo size={10} className="text-background" />
        </span>
        <span className="text-foreground text-xs font-semibold">
          Kortix Runtime
          <span className="text-muted-foreground ml-1 font-normal">(OpenCode)</span>
        </span>
      </div>
      <div className="flex flex-col gap-2 p-3">
        {BRANCHES.map((name) => (
          <div
            key={name}
            className="border-border/70 flex items-center gap-2 rounded-lg border border-dashed px-3 py-2"
          >
            <GitBranch className="text-muted-foreground size-3.5 shrink-0" />
            <span className="text-foreground min-w-0 truncate font-mono text-xs">{name}</span>
          </div>
        ))}
      </div>
      <p className="text-muted-foreground/80 border-border/60 border-t px-4 py-2.5 font-mono text-xs">
        own sandbox · own branch
      </p>
    </div>
  );
}

/** 03 — a change-request chip landing back in the repo. */
function ChangeRequestVisual() {
  return (
    <div className="border-border bg-background overflow-hidden rounded-2xl border">
      <div className="border-border/60 text-muted-foreground flex items-center gap-2 border-b px-4 py-2.5 font-mono text-xs">
        <GitPullRequestArrow className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">→ your-company · main</span>
      </div>
      <div className="flex items-start gap-3 px-4 py-3.5">
        <GitPullRequestArrow className="text-kortix-green mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-foreground text-sm font-medium">Triage 14 new tickets</p>
          <p className="text-muted-foreground font-mono text-xs">
            #4131 · <span className="text-kortix-green">+612</span> −38 · opens CR
          </p>
        </div>
      </div>
      <p className="text-muted-foreground/80 border-border/60 border-t px-4 py-2.5 font-mono text-xs">
        auditable · in your repo
      </p>
    </div>
  );
}

export function RuntimeArchitecture() {
  return (
    <section id="runtime" className={sectionShell}>
      <Reveal>
        <div className="mx-auto mb-14 max-w-3xl space-y-3 text-center">
          <Badge variant="kortix" className="rounded">
            How it works
          </Badge>
          <h2 className="text-foreground text-3xl font-medium tracking-tight text-balance sm:text-4xl">
            The Kortix Runtime
          </h2>
          <p className="text-muted-foreground text-base leading-relaxed text-balance">
            One repo is the source of truth. The runtime runs each task in its own sandbox, then
            lands the work back as a reviewable change request.
          </p>
        </div>
      </Reveal>

      <Reveal delay={0.1}>
        <div className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-3">
          <StepCard
            index="01"
            title="Source of truth"
            line="Your company is a Git repo — agents, context, and code all live as files."
          >
            <RepoVisual />
          </StepCard>

          <StepCard
            index="02"
            title="The Kortix Runtime (OpenCode) runs it"
            line="It reads the files and spins up each task in its own sandbox, on its own branch."
          >
            <RuntimeVisual />
          </StepCard>

          <StepCard
            index="03"
            title="The work lands back"
            line="Each run writes back and opens a change request into your repo — auditable."
          >
            <ChangeRequestVisual />
          </StepCard>
        </div>
      </Reveal>

      <Reveal delay={0.15}>
        <p className="text-muted-foreground/80 mt-8 text-center text-sm">
          Your files → the runtime runs them → the work lands back as a CR.
        </p>
      </Reveal>
    </section>
  );
}

export default RuntimeArchitecture;
