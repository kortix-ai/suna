'use client';

import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Flag,
  Plus,
  CheckCircle2,
  ArrowUpRight,
  Calendar,
  AlertTriangle,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  useMilestones,
  type Milestone,
  type MilestoneStatus,
} from '@/hooks/kortix/use-milestones';
import { MilestoneDialog } from './milestone-dialog';

export function MilestonesTab({ projectId }: { projectId: string }) {
  const { data, isLoading } = useMilestones(projectId, 'all');
  const [dialog, setDialog] = useState<{ mode: 'create' } | { mode: 'edit'; milestone: Milestone } | null>(null);

  const { open, closed, avgPercent } = useMemo(() => {
    const all = data ?? [];
    const o = all.filter((m) => m.status === 'open');
    const c = all.filter((m) => m.status !== 'open');
    const avg = o.length === 0 ? 0 : Math.round(o.reduce((acc, m) => acc + m.percent_complete, 0) / o.length);
    return { open: o, closed: c, avgPercent: avg };
  }, [data]);

  return (
    <div className="h-full overflow-y-auto">
      <motion.div
        initial="hidden"
        animate="show"
        variants={{
          hidden: {},
          show: { transition: { staggerChildren: 0.04, delayChildren: 0.04 } },
        }}
        className="mx-auto w-full max-w-3xl px-6 pt-12 pb-24"
      >
        <Section>
          <header>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              Milestones
            </h1>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              Outcome-level goals. Group related tickets and verify done by acceptance criteria.
            </p>
          </header>
        </Section>

        <Section delay>
          <StatsRow
            open={open.length}
            closed={closed.length}
            avgPercent={avgPercent}
            hasOpen={open.length > 0}
            onNew={() => setDialog({ mode: 'create' })}
          />
        </Section>

        <Section delay>
          <div>
            <SectionLabel
              icon={Flag}
              label="Active"
              count={open.length}
              action={
                open.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setDialog({ mode: 'create' })}
                    className="inline-flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <Plus className="size-3" />
                    New
                  </button>
                ) : null
              }
            />
            <div className="mt-3 overflow-hidden rounded-2xl bg-muted/30">
              {isLoading ? (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground/55">Loading…</div>
              ) : open.length === 0 ? (
                <button
                  onClick={() => setDialog({ mode: 'create' })}
                  className="group flex w-full items-start gap-3 px-4 py-6 text-left transition-colors hover:bg-muted/60"
                >
                  <Flag className="mt-0.5 size-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-foreground/60" />
                  <div>
                    <p className="text-sm font-medium text-foreground">No open milestones</p>
                    <p className="mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
                      Group tickets by end-to-end outcome. PM runs the acceptance criteria to verify done.
                    </p>
                  </div>
                </button>
              ) : (
                open.map((m, i) => (
                  <MilestoneRow
                    key={m.id}
                    milestone={m}
                    onClick={() => setDialog({ mode: 'edit', milestone: m })}
                    isLast={i === open.length - 1}
                  />
                ))
              )}
            </div>
          </div>
        </Section>

        {closed.length > 0 && (
          <Section delay>
            <div>
              <SectionLabel icon={CheckCircle2} label="Closed" count={closed.length} />
              <div className="mt-3 overflow-hidden rounded-2xl bg-muted/20">
                {closed.map((m, i) => (
                  <MilestoneRow
                    key={m.id}
                    milestone={m}
                    onClick={() => setDialog({ mode: 'edit', milestone: m })}
                    isLast={i === closed.length - 1}
                    subdued
                  />
                ))}
              </div>
            </div>
          </Section>
        )}
      </motion.div>

      <MilestoneDialog
        projectId={projectId}
        open={dialog !== null}
        onOpenChange={(o) => { if (!o) setDialog(null); }}
        milestone={dialog?.mode === 'edit' ? dialog.milestone : null}
      />
    </div>
  );
}

function Section({ children, delay }: { children: React.ReactNode; delay?: boolean }) {
  return (
    <motion.section
      variants={{
        hidden: { opacity: 0, y: 6 },
        show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' } },
      }}
      className={cn(delay && 'mt-10')}
    >
      {children}
    </motion.section>
  );
}

function SectionLabel({
  icon: Icon,
  label,
  count,
  action,
}: {
  icon: typeof Flag;
  label: string;
  count?: number;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Icon className="size-3.5 text-muted-foreground/60" />
        <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </h2>
        {typeof count === 'number' && count > 0 && (
          <Badge variant="muted" size="sm" className="tabular-nums">
            {count}
          </Badge>
        )}
      </div>
      {action}
    </div>
  );
}

function StatsRow({
  open,
  closed,
  avgPercent,
  hasOpen,
  onNew,
}: {
  open: number;
  closed: number;
  avgPercent: number;
  hasOpen: boolean;
  onNew: () => void;
}) {
  const stats: Array<{ label: string; value: string | number; dot: string }> = [
    { label: open === 1 ? 'open' : 'open', value: open, dot: 'bg-emerald-500' },
    { label: closed === 1 ? 'closed' : 'closed', value: closed, dot: 'bg-muted-foreground/50' },
  ];
  if (hasOpen) {
    stats.push({ label: 'avg progress', value: `${avgPercent}%`, dot: 'bg-blue-500' });
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
      {stats.map((s) => (
        <span
          key={s.label}
          className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs text-muted-foreground"
        >
          <span className={cn('size-1.5 rounded-full', s.dot)} />
          <span className="font-semibold tabular-nums text-foreground">{s.value}</span>
          <span>{s.label}</span>
        </span>
      ))}
      <Button
        size="sm"
        onClick={onNew}
        className="ml-auto"
      >
        <Plus />
        New milestone
      </Button>
    </div>
  );
}

function MilestoneRow({
  milestone,
  onClick,
  isLast,
  subdued,
}: {
  milestone: Milestone;
  onClick: () => void;
  isLast: boolean;
  subdued?: boolean;
}) {
  const hue = milestone.color_hue ?? 210;
  const acceptance = milestone.acceptance_md.trim().split('\n')[0]?.slice(0, 90) ?? '';
  const due = milestone.due_at ? new Date(milestone.due_at) : null;
  const overdue = due && due < new Date() && milestone.status === 'open';

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60',
        !isLast && 'border-b border-border/40',
        subdued && 'opacity-70 hover:opacity-100',
      )}
    >
      <span
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: `hsl(${hue} 70% 55%)` }}
      />
      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground/60">
        M{milestone.number}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {milestone.title}
        {acceptance && (
          <span className="ml-2 text-muted-foreground/55">{acceptance}</span>
        )}
      </span>

      {due && (
        <span className={cn(
          'hidden items-center gap-1 text-xs tabular-nums sm:inline-flex',
          overdue ? 'text-amber-500' : 'text-muted-foreground/60',
        )}>
          {overdue && <AlertTriangle className="size-3" />}
          <Calendar className="size-3" />
          {due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
        </span>
      )}

      <StatusChip status={milestone.status} />

      <span className="hidden shrink-0 items-center gap-2 sm:flex">
        <span className="text-xs tabular-nums text-muted-foreground/60">
          {milestone.progress.done}/{milestone.progress.total}
        </span>
        <span className="relative h-1 w-16 overflow-hidden rounded-full bg-muted">
          <span
            className="absolute inset-y-0 left-0 rounded-full"
            style={{
              width: `${milestone.percent_complete}%`,
              backgroundColor: `hsl(${hue} 70% 55%)`,
              opacity: subdued ? 0.5 : 0.85,
            }}
          />
        </span>
        <span className="w-8 text-right text-xs font-medium tabular-nums text-foreground/80">
          {milestone.percent_complete}%
        </span>
      </span>

      <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground/30 transition-all group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-foreground" />
    </button>
  );
}

function StatusChip({ status }: { status: MilestoneStatus }) {
  if (status === 'open') return null;
  const Icon = status === 'closed' ? CheckCircle2 : XCircle;
  return (
    <span className="hidden items-center gap-1 text-xs uppercase tracking-wider text-muted-foreground/60 sm:inline-flex">
      <Icon className="size-3" />
      {status}
    </span>
  );
}
