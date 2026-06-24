'use client';

import { CodeWindow } from '@/components/home/code-window';
import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import type { LucideIcon } from 'lucide-react';
import { FolderGit2, GitBranch, Plug, Unlock } from 'lucide-react';

const sectionShell = 'mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0';

type Point = {
  title: string;
  body: string;
  icon: LucideIcon;
};

const POINTS: Point[] = [
  {
    icon: FolderGit2,
    title: 'Your company, as files',
    body: 'Context, docs, agents, and memory live as plain files in one repo. Versioned, reviewable, yours.',
  },
  {
    icon: Plug,
    title: 'One manifest wires it up',
    body: 'A single kortix.toml connects 3,000+ tools via the Executor, plus triggers and permissions.',
  },
  {
    icon: GitBranch,
    title: 'Every task is isolated',
    body: 'Each run gets its own sandbox on its own branch — so work is reproducible and safe to ship.',
  },
  {
    icon: Unlock,
    title: 'Open-source & self-hostable',
    body: 'No lock-in. Run it on your own infrastructure, with your own keys, on your own terms.',
  },
];

export function CompanyAsRepo() {
  return (
    <section id="company-as-repo" className={sectionShell}>
      <Reveal>
        <div className="grid gap-10 lg:grid-cols-12 lg:items-center">
          <div className="lg:col-span-5">
            <div className="max-w-md space-y-3">
              <Badge variant="kortix" className="rounded">
                The core idea
              </Badge>
              <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
                Kortix turns your company into a Git repo
              </h2>
              <p className="text-muted-foreground text-base leading-relaxed">
                Not a black box. Your whole operation is files in one repository — and every agent
                runs against them.
              </p>
            </div>

            <div className="border-border bg-card mt-8 grid overflow-hidden rounded-sm border sm:grid-cols-2">
              {POINTS.map((point) => {
                const Icon = point.icon;
                return (
                  <div
                    key={point.title}
                    className="border-border p-5 not-first:border-t sm:p-6 sm:[&:nth-child(-n+2)]:border-t-0 sm:[&:nth-child(2n)]:border-l"
                  >
                    <Icon className="text-muted-foreground size-5" />
                    <h3 className="text-foreground mt-4 text-base font-medium tracking-tight">
                      {point.title}
                    </h3>
                    <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
                      {point.body}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="lg:col-span-7">
            <CodeWindow />
          </div>
        </div>
      </Reveal>
    </section>
  );
}

export default CompanyAsRepo;
