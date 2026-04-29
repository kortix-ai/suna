'use client';

import React from 'react';
import { ExternalLink, GitBranch, Plus, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PrSummaryData {
  pr_url: string;
  pr_number: number;
  branch: string;
  diff_additions: number;
  diff_deletions: number;
  ci_status: 'pending' | 'pass' | 'fail' | null;
}

export interface PrSummaryMessage {
  type: 'canvas';
  kind: 'pr_summary';
  id: string;
  data: PrSummaryData;
}

// ─── CI badge ────────────────────────────────────────────────────────────────

function CiBadge({ status }: { status: PrSummaryData['ci_status'] }) {
  if (status === null) return null;

  const config = {
    pass: { label: 'CI pass', className: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-800' },
    fail: { label: 'CI fail', className: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400 border-red-200 dark:border-red-800' },
    pending: { label: 'CI pending', className: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700' },
  }[status];

  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border',
        config.className,
      )}
    >
      {config.label}
    </span>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

interface PrSummaryCardProps {
  message: PrSummaryMessage;
  className?: string;
}

export function PrSummaryCard({ message, className }: PrSummaryCardProps) {
  const { pr_url, pr_number, branch, diff_additions, diff_deletions, ci_status } = message.data;

  // Truncate branch at 40 chars with ellipsis
  const displayBranch = branch.length > 40 ? branch.slice(0, 40) + '…' : branch;

  return (
    <div
      className={cn(
        'rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900/50 p-4 space-y-2',
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          PR #{pr_number}
        </span>
        <CiBadge status={ci_status} />
      </div>

      {/* Branch */}
      <div className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400 font-mono">
        <GitBranch className="h-3 w-3 flex-shrink-0" />
        <span className="truncate">{displayBranch}</span>
      </div>

      {/* Diff stats */}
      <div className="flex items-center gap-3 text-xs">
        <span className="flex items-center gap-0.5 text-green-700 dark:text-green-400 font-mono">
          <Plus className="h-3 w-3" />
          {diff_additions}
        </span>
        <span className="flex items-center gap-0.5 text-red-700 dark:text-red-400 font-mono">
          <Minus className="h-3 w-3" />
          {diff_deletions}
        </span>
      </div>

      {/* View PR button */}
      <Button
        variant="outline"
        size="sm"
        className="w-full mt-1 gap-1.5 text-xs"
        asChild
      >
        <a href={pr_url} target="_blank" rel="noopener noreferrer">
          <ExternalLink className="h-3 w-3" />
          View PR
        </a>
      </Button>
    </div>
  );
}

// ─── Renderer map entry ───────────────────────────────────────────────────────
// Register by exporting this constant. The canvas renderer should import and use it.

export const PR_SUMMARY_KIND = 'pr_summary' as const;
