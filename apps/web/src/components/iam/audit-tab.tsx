'use client';

import { useTranslations } from 'next-intl';

// Audit log tab on the account page. Reads from the global
// kortix.audit_events table — combines the generic middleware-logged HTTP
// audit rows with the detailed IAM mutation rows (iam.policy.*,
// iam.group.*, iam.member.super_admin.*). Cursor-paginated, with a quick
// filter chip set for the most common admin questions.

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getSupabaseAccessTokenWithRetry } from '@/lib/auth-token';
import { getEnv } from '@/lib/env-config';
import { errorToast, successToast } from '@/components/ui/toast';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Download, Search } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FilterBar, FilterBarItem } from '@/components/ui/tabs';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { listAuditEvents, type AuditEvent } from '@/lib/iam-client';
import { listAccountMembers } from '@kortix/sdk/projects-client';
import {
  formatResourcePill,
  humanizeAuditAction,
  type HumanizedAuditAction,
} from './audit-display-helpers';

// ─── Quick filters ─────────────────────────────────────────────────────────

interface QuickFilter {
  label: string;
  /** Action prefix sent to the API; null = no action filter. */
  action: string | null;
  /** Days back from now; null = no since filter. */
  daysBack: number | null;
}

const QUICK_FILTERS: QuickFilter[] = [
  { label: 'All events', action: null, daysBack: null },
  { label: 'IAM only', action: 'iam.', daysBack: null },
  { label: 'Group changes', action: 'iam.group', daysBack: null },
  { label: 'Project access', action: 'iam.project.group', daysBack: null },
  { label: 'Super-admin grants', action: 'iam.member.super_admin', daysBack: null },
  { label: 'Last 24 hours', action: null, daysBack: 1 },
  { label: 'Last 7 days', action: null, daysBack: 7 },
  { label: 'Last 30 days', action: null, daysBack: 30 },
];

// Leading kind-dot per action kind — kortix tokens only (no raw palette).
const KIND_DOT_TOKEN: Record<HumanizedAuditAction['kind'], string> = {
  create: 'bg-kortix-green',
  update: 'bg-kortix-yellow',
  delete: 'bg-kortix-red',
  grant: 'bg-kortix-green',
  revoke: 'bg-kortix-red',
  attach: 'bg-kortix-blue',
  detach: 'bg-muted-foreground/40',
  read: 'bg-muted-foreground/30',
  export: 'bg-kortix-blue',
  other: 'bg-muted-foreground/30',
};

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
        errorToast('Not signed in');
        return;
      }
      // BACKEND_URL already includes the `/v1` prefix (e.g. https://api.kortix.com/v1),
      // so paths are appended WITHOUT another `/v1` — adding one 404'd the export.
      const base = (getEnv().BACKEND_URL ?? '').replace(/\/+$/, '');
      const url = `${base}/accounts/${accountId}/audit/export?${params.toString()}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        errorToast(`Export failed: ${res.status} ${text.slice(0, 120)}`);
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
      successToast(
        capped
          ? `Exported ${rowCount} events (capped — narrow your filter for older data)`
          : `Exported ${rowCount} events`,
      );
    } catch (err) {
      errorToast((err as Error).message || 'Export failed');
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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-foreground text-sm font-medium">Audit log</p>
          <p className="text-muted-foreground text-xs">
            {tHardcodedUi.raw(
              'componentsIamAuditTab.line91JsxAttrDescriptionEveryStateChangingApiHitPlusBeforeAfter',
            )}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="sm" disabled={exporting} className="gap-1.5">
              {exporting ? <Loading className="size-4 shrink-0" /> : <Download className="size-4" />}
              Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onSelect={() => exportEvents('csv')}>
              Download CSV
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => exportEvents('jsonl')}>
              Download JSONL
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <FilterBar className="h-auto flex-wrap justify-start">
        {QUICK_FILTERS.map((f, i) => (
          <FilterBarItem
            key={f.label}
            onClick={() => setFilterIndex(i)}
            data-state={filterIndex === i ? 'active' : 'inactive'}
          >
            {f.label}
          </FilterBarItem>
        ))}
      </FilterBar>

      {query.isError && (
        <ErrorState
          size="sm"
          title="Failed to load audit events"
          description={(query.error as Error)?.message}
          action={
            <Button variant="outline" size="sm" onClick={() => query.refetch()}>
              Retry
            </Button>
          }
        />
      )}

      {query.isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[58px] w-full rounded-md" />
          ))}
        </div>
      )}

      {!query.isLoading && !query.isError && allEvents.length === 0 && (
        <EmptyState
          icon={Search}
          size="sm"
          title="No events match this filter"
          description={tHardcodedUi.raw(
            'componentsIamAuditTab.line142JsxTextTryABroaderFilterOrCheckBackAfter',
          )}
        />
      )}

      {!query.isLoading && !query.isError && allEvents.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Event</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Occurred</TableHead>
              <TableHead>Resource</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {allEvents.map((e) => (
              <AuditRow
                key={e.event_id}
                event={e}
                actorEmail={e.actor_user_id ? (emailByUserId.get(e.actor_user_id) ?? null) : null}
              />
            ))}
          </TableBody>
        </Table>
      )}

      {query.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            className="gap-1.5"
          >
            {query.isFetchingNextPage && <Loading className="size-3.5 shrink-0" />}
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────

function AuditRow({ event, actorEmail }: { event: AuditEvent; actorEmail: string | null }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [expanded, setExpanded] = useState(false);
  const hasDiff = event.before !== null || event.after !== null;
  const actorLabel = actorEmail ?? event.actor_user_id ?? 'system';
  const occurred = new Date(event.occurred_at);
  const human = humanizeAuditAction(event.action);
  const resourcePill = formatResourcePill(event.resource_type, event.resource_id);
  // Expandable when we have a before/after diff OR when the humanised
  // title actually hides information (we'd want to surface the raw
  // action code + IP + full timestamp on demand).
  const canExpand = hasDiff || event.action !== human.title;

  return (
    <>
      <TableRow
        className={cn(canExpand && 'cursor-pointer')}
        onClick={() => canExpand && setExpanded((v) => !v)}
      >
        <TableCell className="max-w-[320px] whitespace-normal">
          <div className="flex items-center gap-2">
            <span
              className={cn('size-1.5 shrink-0 rounded-full', KIND_DOT_TOKEN[human.kind])}
              aria-hidden
            />
            <span className="text-foreground truncate text-sm font-medium">{human.title}</span>
            {human.detail && (
              <code className="bg-muted/40 text-foreground truncate rounded px-1.5 py-0.5 font-mono text-xs">
                {human.detail}
              </code>
            )}
          </div>
        </TableCell>
        <TableCell className="text-muted-foreground text-xs">{actorLabel}</TableCell>
        <TableCell className="text-muted-foreground text-xs" title={occurred.toLocaleString()}>
          {formatRelative(occurred)}
        </TableCell>
        <TableCell className="text-muted-foreground text-xs">
          {resourcePill ? (
            <Badge
              variant="outline"
              size="xs"
              className="font-normal capitalize"
              title={
                event.resource_id
                  ? `${event.resource_type} ${event.resource_id}`
                  : (event.resource_type ?? undefined)
              }
            >
              {resourcePill}
            </Badge>
          ) : (
            '—'
          )}
        </TableCell>
      </TableRow>
      {expanded && canExpand && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={4} className="bg-muted/10 space-y-3 whitespace-normal">
            {/* Raw action code — the one the humanizer hid. Visible on
                expand so the dev side of the audit (filtering, support
                tickets) stays one click away. */}
            <div className="space-y-1">
              <p className="text-muted-foreground text-xs font-medium">
                {tI18nHardcoded.raw('autoComponentsIamAuditTabJsxTextRawRequeste6f7c98c')}
              </p>
              <code className="border-border bg-background text-foreground block rounded border px-2 py-1.5 font-mono text-xs break-all">
                {event.action}
              </code>
            </div>
            {/* Full timestamp + event id — useful for cross-referencing
                from server logs. */}
            <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <span>
                {tI18nHardcoded.raw('autoComponentsIamAuditTabJsxTextOccurredAteaaebdde')}
                <span className="font-mono">{occurred.toISOString()}</span>
              </span>
              <span>
                {tI18nHardcoded.raw('autoComponentsIamAuditTabJsxTextEventIde196847b')}
                <span className="font-mono">{event.event_id}</span>
              </span>
            </div>
            {hasDiff && (
              <div className="grid gap-3 sm:grid-cols-2">
                <DiffPane label="Before" data={event.before} />
                <DiffPane label="After" data={event.after} />
              </div>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function DiffPane({ label, data }: { label: string; data: Record<string, unknown> | null }) {
  return (
    <div>
      <p className="text-muted-foreground mb-1 text-xs font-medium">{label}</p>
      <pre className="border-border bg-background text-foreground max-h-48 overflow-auto rounded-md border px-2.5 py-2 text-xs leading-relaxed">
        {data === null ? (
          <span className="text-muted-foreground">None</span>
        ) : (
          JSON.stringify(data, null, 2)
        )}
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
