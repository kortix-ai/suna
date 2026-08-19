'use client';

import type { SessionCostDetail, SessionCostLedgerEntry } from '@kortix/sdk';
import {
  ArrowSquareOutIcon as ExternalLink,
  ReceiptIcon as ReceiptText,
} from '@phosphor-icons/react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/features/layout/section/empty-state';

import {
  formatSessionCostDuration,
  formatSessionCostExactUsd,
  formatSessionCostUsd,
} from './session-cost-format';

interface SessionCostDetailContentProps {
  detail: SessionCostDetail | undefined;
  isLoading: boolean;
  error: Error | null;
}

const timestampFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatTimestamp(value: string): string {
  return timestampFormat.format(new Date(value));
}

function ledgerTimestamp(entry: SessionCostLedgerEntry): string {
  return entry.kind === 'llm' ? entry.occurred_at : entry.billed_through_at;
}

function LedgerEntryDescription({ entry }: { entry: SessionCostLedgerEntry }) {
  if (entry.kind === 'llm') {
    return (
      <div className="min-w-0">
        <p className="truncate text-sm">
          {entry.provider} / {entry.model}
        </p>
        <p className="text-muted-foreground mt-0.5 truncate font-mono text-xs">
          {entry.request_id}
        </p>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <p className="truncate text-sm">
        {entry.provider} · {entry.state}
      </p>
      <p className="text-muted-foreground mt-0.5 text-xs">
        {entry.cpu_cores} vCPU · {entry.memory_gb} GB RAM · {entry.disk_gb} GB disk
      </p>
    </div>
  );
}

export function SessionCostDetailContent({
  detail,
  isLoading,
  error,
}: SessionCostDetailContentProps) {
  if (error) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-medium">Session cost details</h2>
        <InfoBanner tone="destructive" title="Failed to load session cost details">
          {error.message}
        </InfoBanner>
      </div>
    );
  }

  if (isLoading || !detail) {
    return (
      <div className="space-y-4" aria-label="Loading session cost details">
        <h2 className="text-lg font-medium">Session cost details</h2>
        <Skeleton className="h-20 w-full rounded-md" />
        <Skeleton className="h-40 w-full rounded-md" />
      </div>
    );
  }

  const tokenTotal = detail.input_tokens + detail.output_tokens;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-medium">Session cost details</h2>
          <p className="text-muted-foreground mt-1 truncate font-mono text-xs">
            {detail.session_id}
          </p>
          <p className="text-muted-foreground mt-1 text-sm">
            {detail.project_name}
            {detail.owner_name || detail.owner_email
              ? ` · ${detail.owner_name ?? detail.owner_email}`
              : ''}
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href={`/projects/${detail.project_id}/sessions/${detail.session_id}`}>
            Open session
            <ExternalLink className="size-3.5" />
          </Link>
        </Button>
      </div>

      {/* Hairlines are the grid GAP over a `bg-border` surface, not
          `divide-x divide-y`. Tailwind's divide utilities compile to
          `> * + *` — DOM order, with no knowledge of rows or columns — so at
          `sm:grid-cols-3` tiles 2 and 3 drew a stray horizontal rule inside
          row 1 and tile 4 drew a dangling left border at the start of row 2.
          A 1px gap follows the real grid geometry, so no edge dangles at
          either column count. Same treatment as `CostSummaryTiles`; see its
          `GRID_CLASS` comment for the constraint this introduces.

          Six tiles is the one count that fills its rows at BOTH 2 and 3
          columns (6 % 2 === 0, 6 % 3 === 0), so no empty track can show the
          container's border colour and this grid needs no filler cells. The
          array below is a fixed literal — do not add or remove a tile without
          re-checking that against both column counts. */}
      <div className="border-border bg-border grid grid-cols-2 gap-px overflow-hidden rounded-md border sm:grid-cols-3">
        {[
          ['Total', formatSessionCostUsd(detail.total_cost)],
          ['LLM', formatSessionCostUsd(detail.llm_cost)],
          ['Compute', formatSessionCostUsd(detail.compute_cost)],
          ['Requests', detail.request_count.toLocaleString('en-US')],
          ['Tokens', tokenTotal.toLocaleString('en-US')],
          ['Compute time', formatSessionCostDuration(detail.compute_seconds)],
        ].map(([label, value]) => (
          <div key={label} className="bg-popover px-3 py-2.5">
            <p className="text-muted-foreground text-xs">{label}</p>
            <p className="mt-0.5 font-mono text-sm font-medium tabular-nums">{value}</p>
          </div>
        ))}
      </div>

      <section className="space-y-2">
        <div>
          <h3 className="text-sm font-medium">Model usage</h3>
          <p className="text-muted-foreground text-xs">
            Finalized LLM requests grouped by provider and model.
          </p>
        </div>
        {detail.model_usage.length === 0 ? (
          <p className="text-muted-foreground py-4 text-sm">No model usage.</p>
        ) : (
          <div className="overflow-hidden rounded-md">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.model_usage.map((usage) => (
                  <TableRow key={`${usage.provider}/${usage.model}`}>
                    <TableCell>
                      <p className="text-sm">{usage.model}</p>
                      <p className="text-muted-foreground text-xs">{usage.provider}</p>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {usage.request_count.toLocaleString('en-US')}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {(usage.input_tokens + usage.output_tokens).toLocaleString('en-US')}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {formatSessionCostUsd(usage.cost)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <div>
          <h3 className="text-sm font-medium">Cost entries</h3>
          <p className="text-muted-foreground text-xs">
            Finalized LLM requests and billed compute windows.
          </p>
        </div>
        {detail.ledger_entries.length === 0 ? (
          <EmptyState
            size="sm"
            icon={ReceiptText}
            title="No cost entries"
            description="This session has no finalized LLM or compute entries."
          />
        ) : (
          <div className="overflow-hidden rounded-md">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[110px]">Type</TableHead>
                  <TableHead>Entry</TableHead>
                  <TableHead className="text-right">Usage</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="w-[170px]">Billed at</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.ledger_entries.map((entry) => (
                  <TableRow key={`${entry.kind}:${entry.id}`}>
                    <TableCell>
                      <Badge variant="outline" size="sm">
                        {entry.kind === 'llm' ? 'LLM' : 'Compute'}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-[240px]">
                      <LedgerEntryDescription entry={entry} />
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {entry.kind === 'llm'
                        ? `${(entry.input_tokens + entry.output_tokens).toLocaleString('en-US')} tokens`
                        : formatSessionCostDuration(entry.compute_seconds)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {formatSessionCostExactUsd(entry.cost)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {formatTimestamp(ledgerTimestamp(entry))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}
