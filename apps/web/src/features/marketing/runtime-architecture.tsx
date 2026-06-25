'use client';

import { Reveal } from '@/components/home/reveal';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';
import { Bot, Code2, FileText, GitBranch, GitMerge } from 'lucide-react';

const sectionShell = 'mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0';

type FileGroup = {
  icon: LucideIcon;
  label: string;
  path: string;
};

const FILE_GROUPS: FileGroup[] = [
  { icon: Bot, label: 'Agents', path: 'agents/*.md' },
  { icon: FileText, label: 'Context', path: 'memory/*.md · AGENTS.md' },
  { icon: Code2, label: 'Code', path: 'the codebase' },
];

// One sandbox/branch lane fanning out of the runtime.
const SANDBOXES = ['triage-tickets', 'build-board-deck', 'draft-outreach'];

function FileGroupCard({ group }: { group: FileGroup }) {
  const Icon = group.icon;
  return (
    <div className="border-border bg-background flex flex-col items-center gap-2 rounded-xl border p-4 text-center">
      <span className="border-border text-foreground flex size-9 items-center justify-center rounded-lg border">
        <Icon className="size-4" />
      </span>
      <span className="text-foreground text-sm font-medium">{group.label}</span>
      <span className="text-muted-foreground font-mono text-xs">{group.path}</span>
    </div>
  );
}

function Connector({ label, className }: { label?: string; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center', className)} aria-hidden>
      <span className="bg-border h-4 w-px" />
      {label ? (
        <span className="text-muted-foreground py-1 text-center font-mono text-xs">{label}</span>
      ) : null}
      <span className="bg-border h-4 w-px" />
    </div>
  );
}

export function RuntimeArchitecture() {
  return (
    <section id="runtime" className={sectionShell}>
      <Reveal>
        <div className="mb-10 max-w-2xl space-y-3">
          <Badge variant="kortix" className="rounded">
            How it works
          </Badge>
          <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
            The Kortix Runtime
          </h2>
          <p className="text-muted-foreground text-base leading-relaxed">
            One Git repo is your source of truth. Agents, context, and code — all just files. The
            Kortix Runtime runs them.
          </p>
        </div>
      </Reveal>

      <Reveal delay={0.1}>
        <div className="border-border bg-card mx-auto flex max-w-3xl flex-col items-stretch rounded-2xl border p-6 sm:p-10">
          {/* Runtime layer */}
          <div className="border-border bg-background flex flex-col gap-3 rounded-xl border p-5">
            <div className="flex items-center justify-center gap-2.5">
              <span className="bg-foreground flex size-7 shrink-0 items-center justify-center rounded-md">
                <KortixLogo size={14} className="text-background" />
              </span>
              <span className="text-foreground text-sm font-semibold">
                Kortix Runtime
                <span className="text-muted-foreground ml-1.5 font-normal">(OpenCode)</span>
              </span>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {SANDBOXES.map((name) => (
                <div
                  key={name}
                  className="border-border/70 text-muted-foreground flex items-center gap-1.5 rounded-lg border border-dashed px-2.5 py-2 font-mono text-xs"
                >
                  <GitBranch className="size-3 shrink-0" />
                  <span className="truncate">{name}</span>
                </div>
              ))}
            </div>
            <p className="text-muted-foreground/80 text-center text-xs">
              each task in its own sandbox, on its own branch
            </p>
          </div>

          {/* Flow: runs / reads down, writes back up */}
          <div className="flex items-stretch justify-center gap-10 px-6">
            <Connector label="runs · reads files" />
            <Connector label="writes back · opens CR" />
          </div>

          {/* Repo = source of truth */}
          <div className="border-border bg-background relative overflow-hidden rounded-xl border p-5">
            <div className="mb-4 flex flex-wrap items-center justify-center gap-2 text-center">
              <span className="border-border text-foreground inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-xs">
                <GitMerge className="size-3" />
                git repo · main
              </span>
              <span className="text-foreground text-sm font-semibold">the source of truth</span>
            </div>

            <p className="text-muted-foreground mb-4 text-center text-sm">
              Everything is just files.
            </p>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {FILE_GROUPS.map((group) => (
                <FileGroupCard key={group.label} group={group} />
              ))}
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

export default RuntimeArchitecture;
