'use client';

/**
 * Milestones tab — outcome-level grouping for v2 projects.
 *
 * Layout: 2-column card grid on md+ (single column on mobile). Each card
 * has ONE dominant visual (the progress bar) plus breathing room around
 * it. Metadata is muted and compact. Closed milestones live in their
 * own section below the open ones, visually de-emphasized.
 *
 * No sidebar, no dense list rows. Clicking a card opens MilestoneDialog
 * (modal) which handles details + linked tickets + activity + close
 * actions in one place.
 */

import { useMemo, useState } from 'react';
import { Flag, Plus, CheckCircle2, XCircle, Circle, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
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
  const [showClosed, setShowClosed] = useState(true);

  const { open, closed } = useMemo(() => {
    const all = data ?? [];
    return {
      open: all.filter((m) => m.status === 'open'),
      closed: all.filter((m) => m.status !== 'open'),
    };
  }, [data]);

  return (
    <div className="flex-1 overflow-y-auto bg-background">
      <div className="container mx-auto max-w-5xl px-4 sm:px-6 py-6 space-y-8">

        <header className="flex items-end justify-between gap-3">
          <div>
            <h2 className="text-[16px] font-semibold tracking-tight">Milestones</h2>
            <p className="text-[12px] text-muted-foreground/60 mt-1 max-w-xl">
              Outcome-level goals. Each milestone groups tickets and defines "done" as a concrete check.
            </p>
          </div>
          <Button size="sm" onClick={() => setDialog({ mode: 'create' })} className="gap-1.5 shrink-0">
            <Plus className="h-3.5 w-3.5" /> New milestone
          </Button>
        </header>

        {isLoading && (
          <div className="text-[12px] text-muted-foreground/50 py-12 text-center">Loading milestones…</div>
        )}

        {!isLoading && open.length === 0 && closed.length === 0 && (
          <EmptyState onCreate={() => setDialog({ mode: 'create' })} />
        )}

        {!isLoading && open.length > 0 && (
          <section>
            <SectionHeader label="Open" count={open.length} />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {open.map((m) => (
                <MilestoneCard
                  key={m.id}
                  milestone={m}
                  onClick={() => setDialog({ mode: 'edit', milestone: m })}
                />
              ))}
            </div>
          </section>
        )}

        {!isLoading && closed.length > 0 && (
          <section>
            <button
              type="button"
              onClick={() => setShowClosed((v) => !v)}
              className="w-full flex items-center gap-2 mb-3 px-1 text-left group"
            >
              <ChevronDown
                className={cn(
                  'h-3.5 w-3.5 text-muted-foreground/40 transition-transform',
                  !showClosed && '-rotate-90',
                )}
              />
              <span className="text-[10px] uppercase tracking-[0.08em] font-semibold text-muted-foreground/55">Closed</span>
              <span className="text-[11px] tabular-nums text-muted-foreground/40">{closed.length}</span>
            </button>
            {showClosed && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {closed.map((m) => (
                  <MilestoneCard
                    key={m.id}
                    milestone={m}
                    onClick={() => setDialog({ mode: 'edit', milestone: m })}
                    subdued
                  />
                ))}
              </div>
            )}
          </section>
        )}
      </div>

      <MilestoneDialog
        projectId={projectId}
        open={dialog !== null}
        onOpenChange={(o) => { if (!o) setDialog(null); }}
        milestone={dialog?.mode === 'edit' ? dialog.milestone : null}
      />
    </div>
  );
}

// ── Section header ──────────────────────────────────────────────────────────

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-baseline gap-2 mb-3 px-1">
      <h3 className="text-[10px] uppercase tracking-[0.08em] font-semibold text-muted-foreground/60">{label}</h3>
      <span className="text-[11px] tabular-nums text-muted-foreground/40">{count}</span>
    </div>
  );
}

// ── Card ────────────────────────────────────────────────────────────────────

function MilestoneCard({
  milestone,
  onClick,
  subdued,
}: {
  milestone: Milestone;
  onClick: () => void;
  subdued?: boolean;
}) {
  const pct = milestone.percent_complete;
  const p = milestone.progress;
  const hue = milestone.color_hue ?? 210;
  const acceptance = milestone.acceptance_md.trim().split('\n')[0]?.slice(0, 140) ?? '';
  const isClosed = milestone.status !== 'open';

  return (
    <button
      onClick={onClick}
      className={cn(
        'group relative w-full text-left rounded-xl border border-border/40 bg-card overflow-hidden',
        'transition-all duration-150',
        'hover:border-border/70 hover:shadow-sm',
        subdued && 'opacity-75 hover:opacity-100',
      )}
    >
      {/* Top accent bar — the hue gives each milestone a quick visual ID */}
      <div
        className="h-0.5 w-full"
        style={{ backgroundColor: `hsl(${hue} 70% 55%)`, opacity: subdued ? 0.5 : 1 }}
      />

      <div className="p-4 space-y-3">
        {/* Title row — title on the left, % on the right (large, tabular) */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={cn(
                  'text-[14px] font-semibold tracking-tight truncate',
                  subdued && 'text-foreground/70',
                )}
              >
                {milestone.title}
              </span>
            </div>
            <div className="flex items-center gap-1.5 mt-0.5 text-[10px] tabular-nums text-muted-foreground/50 font-mono">
              <span>M{milestone.number}</span>
              <span>·</span>
              <span>{p.done}/{p.total} tickets</span>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <span
              className={cn(
                'text-[20px] font-semibold tabular-nums leading-none',
                subdued ? 'text-muted-foreground/60' : 'text-foreground',
              )}
            >
              {pct}%
            </span>
            <StatusBadge status={milestone.status} />
          </div>
        </div>

        {/* Progress — the dominant visual element. Taller (2px) than a
            typical list row so it reads at a glance. */}
        <ProgressBar progress={p} hue={hue} closed={isClosed} />

        {/* Acceptance first line — muted, one-liner. Sits below the
            progress bar so users can skim cards quickly. */}
        {acceptance && (
          <p className={cn(
            'text-[12px] leading-relaxed line-clamp-2',
            subdued ? 'text-muted-foreground/50' : 'text-muted-foreground/75',
          )}>
            {acceptance}
          </p>
        )}
      </div>
    </button>
  );
}

function ProgressBar({
  progress,
  hue,
  closed,
}: {
  progress: { total: number; done: number; in_progress: number; review: number; blocked: number };
  hue: number;
  closed: boolean;
}) {
  if (progress.total === 0) {
    return (
      <div className="h-1.5 rounded-full bg-muted/40 overflow-hidden" title="No tickets yet" />
    );
  }
  if (closed) {
    return (
      <div className="h-1.5 rounded-full bg-muted/40 overflow-hidden">
        <span
          style={{ width: '100%', backgroundColor: `hsl(${hue} 40% 55%)`, display: 'block', height: '100%' }}
        />
      </div>
    );
  }
  const donePct = (progress.done / progress.total) * 100;
  const reviewPct = (progress.review / progress.total) * 100;
  const inProgressPct = (progress.in_progress / progress.total) * 100;
  const blockedPct = (progress.blocked / progress.total) * 100;
  return (
    <div className="h-1.5 rounded-full bg-muted/40 overflow-hidden flex">
      {donePct > 0 && <span style={{ width: `${donePct}%`, backgroundColor: `hsl(${hue} 70% 50%)` }} />}
      {reviewPct > 0 && <span style={{ width: `${reviewPct}%`, backgroundColor: `hsl(${hue} 50% 65%)` }} />}
      {inProgressPct > 0 && <span style={{ width: `${inProgressPct}%`, backgroundColor: `hsl(${hue} 30% 75%)` }} />}
      {blockedPct > 0 && <span style={{ width: `${blockedPct}%`, backgroundColor: 'hsl(35 80% 55%)' }} />}
    </div>
  );
}

function StatusBadge({ status }: { status: MilestoneStatus }) {
  const cfg = {
    open: { label: 'OPEN', cls: 'bg-emerald-500/10 text-emerald-500/90 border-emerald-500/20', Icon: Circle },
    closed: { label: 'CLOSED', cls: 'bg-muted/50 text-muted-foreground border-border/50', Icon: CheckCircle2 },
    cancelled: { label: 'CANCELLED', cls: 'bg-muted/30 text-muted-foreground/60 border-border/40', Icon: XCircle },
  }[status];
  const Icon = cfg.Icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 h-3.5 px-1.5 rounded-full border',
        'text-[9px] font-medium leading-none uppercase tracking-[0.06em] shrink-0',
        cfg.cls,
      )}
    >
      <Icon className="h-[7.5px] w-[7.5px]" />
      {cfg.label}
    </span>
  );
}

// ── Empty ───────────────────────────────────────────────────────────────────

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-border/50 bg-muted/10 p-10 text-center">
      <Flag className="h-6 w-6 text-muted-foreground/40 mx-auto mb-3" />
      <h3 className="text-[13px] font-semibold text-foreground/90">No milestones yet</h3>
      <p className="text-[12px] text-muted-foreground/60 mt-1 max-w-md mx-auto leading-relaxed">
        Milestones group tickets by end-to-end outcome. Create one to declare what "shipped" means for a slice of work.
      </p>
      <Button size="sm" onClick={onCreate} className="mt-4 gap-1.5">
        <Plus className="h-3.5 w-3.5" /> Create first milestone
      </Button>
    </div>
  );
}
