'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InlineMeta } from '@/components/ui/inline-meta';
import { cn } from '@/lib/utils';
import { FolderGit2, GitBranch, Loader2, Plus } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { PageHead } from '../primitives';
import type { ProjectCard } from '../types';

/* The Projects tab — driven by the CLI: `kortix init` adds a `draft`, `kortix
 * ship` flips it `shipping` → `live`. Shared by the standalone hero section and
 * the modular demo (where it renders its empty state). */

function ProjectStatusBadge({ status }: { status: ProjectCard['status'] }) {
  if (status === 'draft') {
    return (
      <Badge size="sm" variant="muted">
        draft
      </Badge>
    );
  }
  if (status === 'shipping') {
    return (
      <Badge size="sm" variant="outline" className="gap-1 text-amber-600 dark:text-amber-500">
        <Loader2 className="size-3 animate-spin" /> shipping
      </Badge>
    );
  }
  return (
    <Badge size="sm" variant="success" className="gap-1">
      <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" /> live
    </Badge>
  );
}

function ProjectRow({ project }: { project: ProjectCard }) {
  const { name, status, files, branch, repo, url } = project;
  const live = status === 'live';
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: 'easeOut' }}
      className="border-border/70 bg-card flex items-center gap-3 rounded-md border p-3.5"
    >
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-lg border transition-colors',
          live
            ? 'border-kortix-green/20 bg-kortix-green/10 text-kortix-green'
            : 'border-border bg-background text-muted-foreground',
        )}
      >
        <FolderGit2 className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-foreground truncate text-sm font-semibold">{name}</span>
          <ProjectStatusBadge status={status} />
        </div>
        <InlineMeta>
          {live && repo ? (
            <span className="font-mono">{repo}</span>
          ) : (
            <span>{files ?? 0} files</span>
          )}
          <span className="inline-flex items-center gap-1">
            <GitBranch className="size-3" />
            {branch}
          </span>
          {live && url && <span className="text-cyan-600 dark:text-cyan-400">{url}</span>}
        </InlineMeta>
      </div>
    </motion.div>
  );
}

export function ProjectsPage({ projects }: { projects: ProjectCard[] }) {
  return (
    <div>
      <PageHead
        title="Projects"
        sub="Each project is a repo your agents run from — scaffolded with kortix init, deployed with kortix ship."
        action={
          <Button variant="default" size="sm">
            <Plus className="size-3.5" /> New project
          </Button>
        }
      />

      {projects.length === 0 ? (
        <div className="border-border/60 text-muted-foreground flex min-h-[18rem] flex-col items-center justify-center gap-3 rounded-md border border-dashed py-12 text-center">
          <span className="border-border bg-card flex size-11 items-center justify-center rounded-xl border">
            <FolderGit2 className="text-muted-foreground/70 size-5" />
          </span>
          <div className="space-y-1">
            <div className="text-foreground text-sm font-medium">No projects yet</div>
            <div className="text-muted-foreground text-xs">
              Run <span className="text-foreground font-mono">kortix init</span> in your terminal to
              scaffold one.
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-2.5">
          <AnimatePresence initial={false}>
            {projects.map((p) => (
              <ProjectRow key={p.name} project={p} />
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
