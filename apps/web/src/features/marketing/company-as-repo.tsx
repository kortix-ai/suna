'use client';

import { CodeWindow } from '@/components/home/code-window';
import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  FileCode2,
  FolderClosed,
  GitBranch,
  KeyRound,
  Layers,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

const sectionShell = 'mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0';

// [name, depth, kind] — mirrors the developers-page hero file-tree pattern.
const REPO_TREE: [string, number, 'dir' | 'file' | 'accent'][] = [
  ['acme', 0, 'dir'],
  ['kortix.toml', 1, 'accent'],
  ['AGENTS.md', 1, 'file'],
  ['.kortix', 1, 'dir'],
  ['agents', 2, 'dir'],
  ['support.md', 3, 'file'],
  ['outbound.md', 3, 'file'],
  ['finance.md', 3, 'file'],
  ['skills', 2, 'dir'],
  ['close-month', 3, 'dir'],
  ['ticket-triage', 3, 'dir'],
  ['memory', 2, 'dir'],
  ['company.md', 3, 'file'],
  ['decisions.md', 3, 'file'],
  ['connectors', 2, 'dir'],
];

type ValueProp = {
  icon: LucideIcon;
  title: string;
  body: ReactNode;
};

const VALUE_PROPS: ValueProp[] = [
  {
    icon: Layers,
    title: 'One place for everything',
    body: (
      <>
        Every agent, skill, and piece of operational knowledge lives in{' '}
        <span className="text-foreground font-medium">a single repo</span> — not scattered across
        ten tools.
      </>
    ),
  },
  {
    icon: ShieldCheck,
    title: 'You own all of it',
    body: (
      <>
        Your data, your agents, your integrations — yours to read, fork, and host.{' '}
        <span className="text-foreground font-medium">Nothing locked in</span> someone else&apos;s
        product.
      </>
    ),
  },
  {
    icon: KeyRound,
    title: 'Secured · one token',
    body: (
      <>
        Every integration runs through{' '}
        <span className="text-foreground font-medium">one connector layer</span> — scoped,
        auditable, revocable from a single place.
      </>
    ),
  },
];

function ValuePropCard({ icon: Icon, title, body }: ValueProp) {
  return (
    <div className="border-border bg-card flex h-full flex-col rounded-2xl border p-5">
      <span className="border-border bg-background text-foreground flex size-9 items-center justify-center rounded-xl border">
        <Icon className="size-4" />
      </span>
      <p className="text-foreground mt-4 text-sm font-medium">{title}</p>
      <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">{body}</p>
    </div>
  );
}

function RepoTree() {
  return (
    <div className="border-card bg-background overflow-hidden rounded-[calc(var(--radius)+2px)] border-4">
      <div className="border-border/60 bg-muted/30 text-muted-foreground flex items-center gap-2 border-b px-4 py-2.5 font-mono text-xs">
        <GitBranch className="size-3.5" />
        your-company / main
      </div>
      <div className="text-foreground px-4 py-3 font-mono text-sm">
        {REPO_TREE.map(([name, depth, kind], i) => (
          <div
            key={i}
            className="flex items-center gap-2 py-0.5"
            style={{ paddingLeft: `${depth * 14}px` }}
          >
            {kind === 'dir' ? (
              <FolderClosed className="text-muted-foreground/60 size-3.5 shrink-0" />
            ) : (
              <FileCode2
                className={cn(
                  'size-3.5 shrink-0',
                  kind === 'accent' ? 'text-kortix-green' : 'text-muted-foreground/60',
                )}
              />
            )}
            <span
              className={cn(
                'tracking-normal',
                kind === 'accent'
                  ? 'text-foreground font-medium'
                  : kind === 'dir'
                    ? 'text-foreground/80'
                    : 'text-muted-foreground',
              )}
            >
              {name}
              {kind === 'dir' ? '/' : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CompanyAsRepo() {
  return (
    <section id="company-as-repo" className={sectionShell}>
      <Reveal>
        <div className="mx-auto mb-12 max-w-3xl space-y-3 text-center">
          <Badge variant="kortix" className="rounded">
            The core idea
          </Badge>
          <h2 className="text-foreground text-3xl font-medium tracking-tight text-balance sm:text-4xl">
            Your whole company as a code repo.
          </h2>
          <p className="text-muted-foreground text-base leading-relaxed text-balance">
            Agents, skills, and context are just files — so everything lives in one place, you own
            every bit of it, and it&apos;s saved and versioned in a single Git repo.
          </p>
        </div>
      </Reveal>

      <Reveal delay={0.05}>
        <div className="mb-10 grid gap-4 sm:grid-cols-3">
          {VALUE_PROPS.map((prop) => (
            <ValuePropCard key={prop.title} {...prop} />
          ))}
        </div>
      </Reveal>

      <Reveal delay={0.1}>
        <div className="grid items-stretch gap-6 lg:grid-cols-[0.85fr_1.15fr]">
          <RepoTree />
          <CodeWindow className="h-full" />
        </div>
      </Reveal>

      <Reveal delay={0.15}>
        <p className="text-muted-foreground mt-8 text-center text-sm">
          One repo. One connector layer. One runtime —{' '}
          <span className="text-foreground font-medium">all of it yours.</span>
        </p>
      </Reveal>
    </section>
  );
}

export default CompanyAsRepo;
