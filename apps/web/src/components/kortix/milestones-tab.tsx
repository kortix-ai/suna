'use client';

/**
 * Milestones tab — outcome-level grouping for v2 projects.
 *
 * One unified view:
 *   - Top toolbar: [+ New milestone] + optional search
 *   - OPEN section: active milestones, full-weight rendering, progress bars
 *   - CLOSED section: completed + cancelled, de-emphasized, collapsible
 *
 * Closed milestones stay visible because they're the historical record of
 * what shipped. "Out of sight = out of mind" is wrong here: the ticket→
 * milestone link is how we prove an outcome was delivered, and closed
 * milestones are still referenced from ticket cards + pickers.
 *
 * Clicking a row opens the detail drawer for inline edits / status
 * transitions / linked-ticket view.
 */

import { useMemo, useState } from 'react';
import { Flag, Plus, CheckCircle2, XCircle, Circle, Clock, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  useMilestones,
  type Milestone,
  type MilestoneStatus,
} from '@/hooks/kortix/use-milestones';
import { MilestoneDialog } from './milestone-dialog';
import { MilestoneDetailDrawer } from './milestone-detail-drawer';

export function MilestonesTab({ projectId }: { projectId: string }) {
  const { data, isLoading } = useMilestones(projectId, 'all');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Milestone | null>(null);
  const [openRef, setOpenRef] = useState<string | null>(null);
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
      <div className="container mx-auto max-w-3xl px-3 sm:px-4 py-5 space-y-6">

        <header className="flex items-end justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold tracking-tight">Milestones</h2>
            <p className="text-[11.5px] text-muted-foreground/60 mt-1">
              Outcome-level goals. Each milestone groups tickets and defines "done" as a concrete check PM can run.
            </p>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" /> New milestone
          </Button>
        </header>

        {isLoading && (
          <div className="text-[12px] text-muted-foreground/50 py-6 text-center">Loading milestones…</div>
        )}

        {!isLoading && open.length === 0 && closed.length === 0 && (
          <EmptyState onCreate={() => setCreateOpen(true)} />
        )}

        {/* OPEN section — always visible, full weight */}
        {!isLoading && open.length > 0 && (
          <section>
            <SectionHeader label="Open" count={open.length} />
            <ul className="rounded-xl border border-border/40 bg-card divide-y divide-border/30 overflow-hidden">
              {open.map((m) => (
                <MilestoneRow
                  key={m.id}
                  milestone={m}
                  onClick={() => setOpenRef(String(m.number))}
                  onEdit={() => setEditing(m)}
                />
              ))}
            </ul>
          </section>
        )}

        {/* CLOSED section — collapsible, de-emphasized */}
        {!isLoading && closed.length > 0 && (
          <section>
            <button
              type="button"
              onClick={() => setShowClosed((v) => !v)}
              className="w-full flex items-center gap-2 mb-2 px-1 text-left group"
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
              <ul className="rounded-xl border border-border/30 bg-card/60 divide-y divide-border/20 overflow-hidden">
                {closed.map((m) => (
                  <MilestoneRow
                    key={m.id}
                    milestone={m}
                    onClick={() => setOpenRef(String(m.number))}
                    onEdit={() => setEditing(m)}
                    subdued
                  />
                ))}
              </ul>
            )}
          </section>
        )}
      </div>

      <MilestoneDialog
        projectId={projectId}
        open={createOpen}
        onOpenChange={setCreateOpen}
        milestone={null}
      />
      <MilestoneDialog
        projectId={projectId}
        open={editing !== null}
        onOpenChange={(o) => { if (!o) setEditing(null); }}
        milestone={editing}
      />
      <MilestoneDetailDrawer
        projectId={projectId}
        milestoneRef={openRef}
        onOpenChange={(o) => { if (!o) setOpenRef(null); }}
      />
    </div>
  );
}

// ── Section header ──────────────────────────────────────────────────────────

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-baseline gap-2 mb-2 px-1">
      <h3 className="text-[10px] uppercase tracking-[0.08em] font-semibold text-muted-foreground/60">{label}</h3>
      <span className="text-[11px] tabular-nums text-muted-foreground/40">{count}</span>
    </div>
  );
}

// ── Row ─────────────────────────────────────────────────────────────────────

function MilestoneRow({
  milestone,
  onClick,
  onEdit,
  subdued,
}: {
  milestone: Milestone;
  onClick: () => void;
  onEdit: () => void;
  /** Closed / cancelled milestones render with reduced visual weight. */
  subdued?: boolean;
}) {
  const pct = milestone.percent_complete;
  const p = milestone.progress;
  const accPreview = milestone.acceptance_md.trim().split('\n')[0]?.slice(0, 180) ?? '';
  const hue = milestone.color_hue ?? 210;
  const isClosed = milestone.status !== 'open';

  return (
    <li className="group">
      <button
        onClick={onClick}
        className={cn(
          'w-full flex items-start gap-3 px-4 py-3 hover:bg-muted/20 transition-colors text-left',
          subdued && 'opacity-70 hover:opacity-100',
        )}
      >
        {/* Color dot */}
        <span
          className="mt-1.5 h-2.5 w-2.5 rounded-full shrink-0"
          style={{
            backgroundColor: `hsl(${hue} 70% 55%)`,
            opacity: subdued ? 0.6 : 1,
          }}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className={cn(
              'text-[13px] font-semibold truncate',
              subdued && 'text-foreground/70',
            )}>
              {milestone.title}
            </span>
            <StatusBadge status={milestone.status} />
            <span className="text-[11px] text-muted-foreground/50 font-mono shrink-0">
              M{milestone.number}
            </span>
          </div>
          {accPreview && (
            <p className={cn(
              'mt-0.5 text-[11.5px] truncate',
              subdued ? 'text-muted-foreground/50' : 'text-muted-foreground/60',
            )}>
              {accPreview}
            </p>
          )}
          <ProgressBar pct={pct} progress={p} hue={hue} closed={isClosed} />
          <div className="mt-1 flex items-center gap-3 text-[10.5px] tabular-nums text-muted-foreground/55">
            <span>{p.done}/{p.total} done</span>
            {p.in_progress > 0 && <span>· {p.in_progress} in progress</span>}
            {p.blocked > 0 && <span className="text-amber-500/90">· {p.blocked} blocked</span>}
            {p.review > 0 && <span>· {p.review} review</span>}
            {milestone.due_at && milestone.status === 'open' && (
              <span className="ml-auto inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {formatDate(milestone.due_at)}
              </span>
            )}
            {isClosed && milestone.completed_at && (
              <span className="ml-auto text-muted-foreground/55">
                closed {formatDate(milestone.completed_at)}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className={cn(
            'text-[16px] font-semibold tabular-nums',
            subdued && 'text-muted-foreground/60',
          )}>{pct}%</span>
          <span
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            className="text-[10.5px] text-muted-foreground/50 hover:text-foreground/80 underline-offset-2 hover:underline cursor-pointer"
          >
            edit
          </span>
        </div>
      </button>
    </li>
  );
}

function ProgressBar({
  pct,
  progress,
  hue,
  closed,
}: {
  pct: number;
  progress: { total: number; done: number; in_progress: number; review: number; blocked: number };
  hue: number;
  closed: boolean;
}) {
  if (progress.total === 0) {
    return (
      <div className="mt-1.5 h-1 rounded-full bg-muted/40 overflow-hidden" title="No tickets yet" />
    );
  }
  // Closed milestones get a flat fill — the breakdown is irrelevant post-close.
  if (closed) {
    return (
      <div
        className="mt-1.5 h-1 rounded-full bg-muted/40 overflow-hidden"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span
          style={{
            width: '100%',
            backgroundColor: `hsl(${hue} 40% 55%)`,
            display: 'block',
            height: '100%',
          }}
        />
      </div>
    );
  }
  // Open milestones: segmented — done | review | in_progress | blocked
  const donePct = (progress.done / progress.total) * 100;
  const reviewPct = (progress.review / progress.total) * 100;
  const inProgressPct = (progress.in_progress / progress.total) * 100;
  const blockedPct = (progress.blocked / progress.total) * 100;
  return (
    <div
      className="mt-1.5 h-1 rounded-full bg-muted/40 overflow-hidden flex"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
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
        'inline-flex items-center gap-1 h-4 px-1.5 rounded-full border',
        'text-[9.5px] font-medium leading-none uppercase tracking-[0.06em] shrink-0',
        cfg.cls,
      )}
    >
      <Icon className="h-[8.5px] w-[8.5px]" />
      {cfg.label}
    </span>
  );
}

// ── Empty ───────────────────────────────────────────────────────────────────

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-border/50 bg-muted/10 p-8 text-center">
      <Flag className="h-6 w-6 text-muted-foreground/40 mx-auto mb-3" />
      <h3 className="text-[13px] font-semibold text-foreground/90">No milestones yet</h3>
      <p className="text-[11.5px] text-muted-foreground/60 mt-1 max-w-sm mx-auto">
        Milestones group tickets by end-to-end outcome. Create one to declare what "shipped" means for a slice of work.
      </p>
      <Button size="sm" onClick={onCreate} className="mt-3 gap-1.5">
        <Plus className="h-3.5 w-3.5" /> Create first milestone
      </Button>
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}
