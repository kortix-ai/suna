'use client';

import { DraggableCliPanel } from '@/components/home/interactive-demo/cli/draggable-cli-panel';
import { Badge } from '@/components/ui/badge';
import { InlineMeta } from '@/components/ui/inline-meta';
import { cn } from '@/lib/utils';
import { FolderGit2, GitBranch } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import { StepCliTerminal } from '../step-cli-terminal';
import { useStep1Director, type Step1Project } from '../step-director';
import { WebPanelWrapper } from '../web-panel-wrapper';

/* ─── Projects view (copied from the demo's ProjectsPage, no page switch) ──── */

function ProjectStatusBadge({ status }: { status: Step1Project['status'] }) {
  if (status === 'draft') {
    return (
      <Badge size="sm" variant="muted">
        draft
      </Badge>
    );
  }
  return (
    <Badge size="sm" variant="success" className="gap-1">
      <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" /> live
    </Badge>
  );
}

function ProjectRow({ project }: { project: Step1Project }) {
  const { name, status, files, branch, runtime } = project;
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
          <Badge size="sm" variant="outline" className="font-mono">
            {runtime}
          </Badge>
        </div>
        <InlineMeta>
          <span>{files} files</span>
          <span className="inline-flex items-center gap-1">
            <GitBranch className="size-3" />
            {branch}
          </span>
        </InlineMeta>
      </div>
    </motion.div>
  );
}

function ProjectsView({ projects }: { projects: Step1Project[] }) {
  return (
    <div className="flex h-full flex-col">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-foreground text-lg font-semibold tracking-tight">Projects</h3>
          <p className="text-muted-foreground mt-0.5 text-sm">
            Each project is a repo your agents run from — scaffolded with{' '}
            <span className="text-foreground font-mono">kortix init</span>.
          </p>
        </div>
      </div>

      {projects.length === 0 ? (
        <div className="border-border/60 text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 rounded-md border border-dashed py-10 text-center">
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

function WebPanel({ projects }: { projects: Step1Project[] }) {
  return (
    <WebPanelWrapper activeTab="projects">
      <ProjectsView projects={projects} />
    </WebPanelWrapper>
  );
}

export function Step1ProjectCli() {
  const director = useStep1Director();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          io.disconnect();
          director.start();
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={rootRef} className="relative aspect-19/22 w-full overflow-visible">
      <DraggableCliPanel containerRef={rootRef}>
        {({ dragHandleProps }) => (
          <StepCliTerminal director={director} dragHandleProps={dragHandleProps} />
        )}
      </DraggableCliPanel>

      <WebPanel projects={director.projects} />
    </div>
  );
}
