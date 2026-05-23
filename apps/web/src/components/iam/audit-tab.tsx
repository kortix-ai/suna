'use client';

import { useTranslations } from 'next-intl';

// Audit log tab on the account page. Reads from the global
// kortix.audit_events table — combines the generic middleware-logged HTTP
// audit rows with the detailed IAM mutation rows (iam.policy.*,
// iam.group.*, iam.member.super_admin.*). Cursor-paginated, with a quick
// filter chip set for the most common admin questions.

import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getSupabaseAccessTokenWithRetry } from '@/lib/auth-token';
import { getEnv } from '@/lib/env-config';

import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { listAuditEvents, type AuditEvent } from '@/lib/iam-client';
import { listAccountMembers } from '@/lib/projects-client';

// ─── Quick filters ─────────────────────────────────────────────────────────

interface QuickFilter {
  label: string;
  /** Action prefix sent to the API; null = no action filter. */
  action: string | null;
  /** Days back from now; null = no since filter. */
  daysBack: number | null;
}

const QUICK_FILTERS: QuickFilter[] = [
  { label: 'All events',        action: null,                            daysBack: null },
  { label: 'IAM only',          action: 'iam.',                          daysBack: null },
  { label: 'Policy changes',    action: 'iam.policy',                    daysBack: null },
  { label: 'Group changes',     action: 'iam.group',                     daysBack: null },
  { label: 'Super-admin grants', action: 'iam.member.super_admin',       daysBack: null },
  { label: 'Last 24 hours',     action: null,                            daysBack: 1 },
  { label: 'Last 7 days',       action: null,                            daysBack: 7 },
  { label: 'Last 30 days',      action: null,                            daysBack: 30 },
];

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ─── Component ────────────────────────────────────────────────────────────

interface AuditTabProps {
  accountId: string;
}

export function AuditTab({ accountId }: AuditTabProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [filterIndex, setFilterIndex] = useState(0);
  const [exporting, setExporting] = useState(false);
  const active = QUICK_FILTERS[filterIndex];

  // Streams the export with the active filter, triggers a browser download.
  // We use raw fetch instead of backendApi because the response is a file
  // (text/csv or application/x-ndjson), not the JSON wrapper the client
  // helpers assume.
  async function exportEvents(format: 'csv' | 'jsonl') {
    setExporting(true);
    try {
      const params = new URLSearchParams();
      params.set('format', format);
      if (active.action) params.set('action', active.action);
      if (active.daysBack) params.set('since', daysAgoIso(active.daysBack));

      const token = await getSupabaseAccessTokenWithRetry();
      if (!token) {
        toast.error('Not signed in');
        return;
      }
      const base = getEnv().BACKEND_URL ?? '';
      const url = `${base}/v1/accounts/${accountId}/audit/export?${params.toString()}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        toast.error(`Export failed: ${res.status} ${text.slice(0, 120)}`);
        return;
      }

      const blob = await res.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const filename =
        res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ??
        `audit-${new Date().toISOString().slice(0, 10)}.${format}`;
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(downloadUrl);

      const capped = res.headers.get('x-audit-capped') === 'true';
      const rowCount = res.headers.get('x-audit-row-count') ?? '?';
      toast.success(
        capped
          ? `Exported ${rowCount} events (capped — narrow your filter for older data)`
          : `Exported ${rowCount} events`,
      );
    } catch (err) {
      toast.error((err as Error).message || 'Export failed');
    } finally {
      setExporting(false);
    }
  }

  const query = useInfiniteQuery({
    queryKey: ['audit', accountId, active.action, active.daysBack],
    queryFn: ({ pageParam }) =>
      listAuditEvents(accountId, {
        action: active.action ?? undefined,
        since: active.daysBack ? daysAgoIso(active.daysBack) : undefined,
        cursor: pageParam,
        limit: 50,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });

  // Resolve actor user_ids → emails using the account-members query. Cached
  // by other pages so this is free in practice. Falls back to the raw
  // user_id for actors who aren't current members (deleted users, system).
  const membersQuery = useQuery({
    queryKey: ['account-members', accountId],
    queryFn: () => listAccountMembers(accountId),
    staleTime: 30_000,
  });
  const emailByUserId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of membersQuery.data ?? []) {
      if (m.email) map.set(m.user_id, m.email);
    }
    return map;
  }, [membersQuery.data]);

  const allEvents: AuditEvent[] = useMemo(
    () => (query.data?.pages ?? []).flatMap((p) => p.events),
    [query.data],
  );

  return (
    <SectionCard
      title={tHardcodedUi.raw('componentsIamAuditTab.line90JsxAttrTitleAuditLog')}
      description={tHardcodedUi.raw('componentsIamAuditTab.line91JsxAttrDescriptionEveryStateChangingApiHitPlusBeforeAfter')}
      flush
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-6 py-3">
        <div className="flex flex-wrap gap-1.5">
          {QUICK_FILTERS.map((f, i) => (
            <button
              key={f.label}
              type="button"
              onClick={() => setFilterIndex(i)}
              className={`cursor-pointer rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                filterIndex === i
                  ? 'border-foreground/30 bg-foreground/[0.06] text-foreground'
                  : 'border-border/60 bg-background text-muted-foreground hover:text-foreground'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={exporting} className="gap-1.5">
              {exporting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onSelect={() => exportEvents('csv')}>
              {tHardcodedUi.raw('componentsIamAuditTab.line192JsxTextDownloadCSV')}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => exportEvents('jsonl')}>
              {tHardcodedUi.raw('componentsIamAuditTab.line195JsxTextDownloadJSONL')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {query.isError && (
        <div className="px-6 py-5">
          <p className="text-sm text-destructive">
            {(query.error as Error)?.message || 'Failed to load audit events'}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => query.refetch()}
          >
            Retry
          </Button>
        </div>
      )}

      {query.isLoading && (
        <div className="divide-y divide-border/60">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="px-6 py-3">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="mt-2 h-3 w-1/2" />
            </div>
          ))}
        </div>
      )}

      {!query.isLoading && allEvents.length === 0 && (
        <div className="px-6 py-12 text-center">
          <p className="text-sm font-medium text-foreground">{tHardcodedUi.raw('componentsIamAuditTab.line140JsxTextNoEventsMatchThisFilter')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{tHardcodedUi.raw('componentsIamAuditTab.line142JsxTextTryABroaderFilterOrCheckBackAfter')}</p>
        </div>
      )}

      {!query.isLoading && allEvents.length > 0 && (
        <ul className="divide-y divide-border/60">
          {allEvents.map((e) => (
            <AuditRow
              key={e.event_id}
              event={e}
              actorEmail={e.actor_user_id ? emailByUserId.get(e.actor_user_id) ?? null : null}
            />
          ))}
        </ul>
      )}

      {query.hasNextPage && (
        <div className="flex justify-center border-t border-border/60 px-6 py-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            className="gap-1.5"
          >
            {query.isFetchingNextPage && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{tHardcodedUi.raw('componentsIamAuditTab.line169JsxTextLoadMore')}</Button>
        </div>
      )}
    </SectionCard>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────

function AuditRow({
  event,
  actorEmail,
}: {
  event: AuditEvent;
  actorEmail: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasDiff = event.before !== null || event.after !== null;
  const actorLabel = actorEmail ?? event.actor_user_id ?? 'system';
  const occurred = new Date(event.occurred_at);

  return (
    <li>
      <button
        type="button"
        onClick={() => hasDiff && setExpanded((v) => !v)}
        disabled={!hasDiff}
        className={`flex w-full items-start gap-3 px-6 py-3 text-left transition-colors ${
          hasDiff ? 'cursor-pointer hover:bg-muted/30' : ''
        }`}
      >
        <div className="mt-0.5 w-3 shrink-0 text-muted-foreground">
          {hasDiff && (expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />)}
        </div>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-baseline gap-2">
            <code className="rounded bg-muted/40 px-1.5 py-0.5 font-mono text-xs text-foreground">
              {event.action}
            </code>
            <span className="truncate text-xs text-muted-foreground">
              by <strong className="font-medium text-foreground">{actorLabel}</strong>
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{formatRelative(occurred)}</span>
            <span className="text-muted-foreground/40">·</span>
            <span title={occurred.toISOString()}>{occurred.toLocaleString()}</span>
            {event.resource_id && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span className="truncate font-mono">
                  {event.resource_type}/{event.resource_id.slice(0, 8)}
                </span>
              </>
            )}
            {event.ip && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span className="font-mono">{event.ip}</span>
              </>
            )}
          </div>
        </div>
      </button>
      {expanded && hasDiff && (
        <div className="grid gap-3 border-t border-border/40 bg-muted/10 px-6 py-3 sm:grid-cols-2">
          <DiffPane label="Before" data={event.before} />
          <DiffPane label="After" data={event.after} />
        </div>
      )}
    </li>
  );
}

function DiffPane({ label, data }: { label: string; data: Record<string, unknown> | null }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div>
      <p className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <pre className="max-h-48 overflow-auto rounded-2xl border border-border/60 bg-background px-2.5 py-2 text-xs leading-relaxed text-foreground">
        {data === null ? <span className="text-muted-foreground">{tHardcodedUi.raw('componentsIamAuditTab.line251JsxTextNone')}</span> : JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function formatRelative(d: Date): string {
  const diffMs = Date.now() - d.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}
