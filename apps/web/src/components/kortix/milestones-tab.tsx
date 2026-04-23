'use client';

/**
 * Milestones tab — matches the Team tab's visual pattern exactly.
 *
 *   max-w-3xl container, section label with icon + count + "New" button,
 *   rounded-xl card with border-border/40 divide-y rows.
 *
 * Each row: color dot + title + muted acceptance snippet, a couple of
 * small badges (M-#, N/M done, status), and a pencil on the right. No
 * competing progress bar, no 4-segment breakdown, no standalone % label.
 * One visual line per milestone.
 *
 * Closed milestones render in their own section below, same card style,
 * with reduced opacity.
 */

import { useMemo, useState } from 'react';
import { Flag, Plus, Pencil, Circle, CheckCircle2, XCircle } from 'lucide-react';
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

  const { open, closed } = useMemo(() => {
    const all = data ?? [];
    return {
      open: all.filter((m) => m.status === 'open'),
      closed: all.filter((m) => m.status !== 'open'),
    };
  }, [data]);

  return (
    <div className="h-full overflow-y-auto animate-in fade-in-0 duration-300 fill-mode-both">
      <div className="container mx-auto max-w-3xl px-4 sm:px-6 lg:px-10 py-8 sm:py-10 space-y-8">

        {/* ─── Open milestones ─── */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <Flag className="h-3.5 w-3.5 text-muted-foreground/45" />
            <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">Milestones</span>
            <span className="text-[10px] text-muted-foreground/30 tabular-nums">{open.length}</span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-6 px-2 text-[11px] text-muted-foreground/60 hover:text-foreground gap-1"
              onClick={() => setDialog({ mode: 'create' })}
            >
              <Plus className="h-3 w-3" />
              New milestone
            </Button>
          </div>

          <div className="rounded-xl border border-border/40 divide-y divide-border/30 overflow-hidden bg-card">
            {isLoading ? (
              <div className="py-8 text-center text-[12px] text-muted-foreground/50">Loading…</div>
            ) : open.length === 0 ? (
              <button
                onClick={() => setDialog({ mode: 'create' })}
                className="w-full py-8 text-center hover:bg-muted/20 transition-colors cursor-pointer"
              >
                <p className="text-[12.5px] text-foreground/70 font-medium mb-0.5">No open milestones</p>
                <p className="text-[11.5px] text-muted-foreground/50">Group tickets by end-to-end outcome. Create the first one.</p>
              </button>
            ) : (
              open.map((m) => (
                <MilestoneRow
                  key={m.id}
                  milestone={m}
                  onClick={() => setDialog({ mode: 'edit', milestone: m })}
                />
              ))
            )}
          </div>
        </section>

        {/* ─── Closed milestones ─── */}
        {closed.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground/45" />
              <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">Closed</span>
              <span className="text-[10px] text-muted-foreground/30 tabular-nums">{closed.length}</span>
            </div>

            <div className="rounded-xl border border-border/30 divide-y divide-border/20 overflow-hidden bg-card/60">
              {closed.map((m) => (
                <MilestoneRow
                  key={m.id}
                  milestone={m}
                  onClick={() => setDialog({ mode: 'edit', milestone: m })}
                  subdued
                />
              ))}
            </div>
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

// ─── Row ────────────────────────────────────────────────────────────────────

function MilestoneRow({
  milestone,
  onClick,
  subdued,
}: {
  milestone: Milestone;
  onClick: () => void;
  subdued?: boolean;
}) {
  const hue = milestone.color_hue ?? 210;
  const acceptance = milestone.acceptance_md.trim().split('\n')[0]?.slice(0, 140) ?? '';
  const p = milestone.progress;

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/20 transition-colors cursor-pointer text-left group',
        subdued && 'opacity-75 hover:opacity-100',
      )}
    >
      {/* Color dot — same slot the AgentAvatar fills on the Team tab.
          Sized medium so rows align visually across both tabs. */}
      <div
        className="h-8 w-8 rounded-full shrink-0 flex items-center justify-center"
        style={{ backgroundColor: `hsl(${hue} 70% 55% / 0.15)` }}
      >
        <span
          className="h-3 w-3 rounded-full"
          style={{ backgroundColor: `hsl(${hue} 70% 55%)`, opacity: subdued ? 0.6 : 1 }}
        />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className={cn(
            'text-[13px] font-semibold truncate',
            subdued && 'text-foreground/70',
          )}>
            {milestone.title}
          </span>
          {acceptance && (
            <span className="text-[11.5px] text-muted-foreground/50 truncate">
              {acceptance}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          <span className="inline-flex items-center h-4 px-1.5 rounded text-[10px] font-mono bg-muted/40 text-muted-foreground/70">
            M{milestone.number}
          </span>
          <span className="inline-flex items-center h-4 px-1.5 rounded text-[10px] tabular-nums bg-muted/40 text-muted-foreground/70">
            {p.done}/{p.total} done · {milestone.percent_complete}%
          </span>
          <StatusChip status={milestone.status} />
          {p.blocked > 0 && (
            <span className="inline-flex items-center h-4 px-1.5 rounded text-[10px] bg-amber-500/10 text-amber-400/80">
              {p.blocked} blocked
            </span>
          )}
        </div>
      </div>
      <Pencil className="h-3.5 w-3.5 text-muted-foreground/25 group-hover:text-foreground transition-colors shrink-0" />
    </button>
  );
}

function StatusChip({ status }: { status: MilestoneStatus }) {
  const cfg = {
    open: { label: 'open', cls: 'bg-emerald-500/10 text-emerald-400/80', Icon: Circle },
    closed: { label: 'closed', cls: 'bg-muted/50 text-muted-foreground/80', Icon: CheckCircle2 },
    cancelled: { label: 'cancelled', cls: 'bg-muted/30 text-muted-foreground/60', Icon: XCircle },
  }[status];
  const Icon = cfg.Icon;
  return (
    <span className={cn('inline-flex items-center gap-1 h-4 px-1.5 rounded text-[10px] font-medium', cfg.cls)}>
      <Icon className="h-[8px] w-[8px]" />
      {cfg.label}
    </span>
  );
}
