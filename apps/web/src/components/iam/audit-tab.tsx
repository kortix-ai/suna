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
import { errorToast, successToast } from '@/components/ui/toast';
import { getSupabaseAccessTokenWithRetry } from '@/lib/auth-token';
import { getEnv } from '@/lib/env-config';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Download, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { FilterBar, FilterBarItem } from '@/components/ui/tabs';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { type IamAuditEvent, listAuditEvents } from '@/lib/iam-client';
import { cn } from '@/lib/utils';
import { downloadAccountAudit, listAccountMembers } from '@kortix/sdk';
import {
  type HumanizedAuditAction,
  formatResourcePill,
  humanizeAuditAction,
} from './audit-display-helpers';

// ─── Filters ────────────────────────────────────────────────────────────────

interface AuditFilterState {
  /** Action prefix sent to the API; '' = no action filter. */
  action: string;
  /** actor user_id, or '' for everyone. */
  actor: string;
  /** resource_type prefix, or '' for any. */
  resourceType: string;
  /** Free-text search over action / resource_type / resource_id. */
  q: string;
  /** ISO datetime, or '' for unbounded. */
  since: string;
  until: string;
}

const EMPTY_FILTER: AuditFilterState = {
  action: '',
  actor: '',
  resourceType: '',
  q: '',
  since: '',
  until: '',
};

// Action-kind shortcuts. Clicking one presets `action` (and clears the
// conflicting bits) — the structured filter row still lets you refine on
// top. Kept as chips because they're the 80% "what kind of thing" question.
interface QuickFilter {
  label: string;
  action: string;
}
const QUICK_FILTERS: QuickFilter[] = [
  { label: 'All events', action: '' },
  { label: 'IAM only', action: 'iam.' },
  { label: 'Group changes', action: 'iam.group' },
  { label: 'Project access', action: 'iam.project.group' },
  { label: 'Super-admin grants', action: 'iam.member.super_admin' },
  { label: 'Sessions', action: 'POST /v1/projects' },
  { label: 'Secrets', action: 'projects' },
];

// resource_type buckets the UI offers as a dropdown. '' = any. These are the
// high-cardinality categories a reviewer actually slices by; the API accepts
// any prefix so a caller could pass more.
const RESOURCE_TYPES: { label: string; value: string }[] = [
  { label: 'Any resource', value: '' },
  { label: 'Project', value: 'project' },
  { label: 'Session', value: 'project_session' },
  { label: 'Secret', value: 'project_secret' },
  { label: 'Group', value: 'group' },
  { label: 'Account', value: 'account' },
  { label: 'Audit webhook', value: 'audit_webhook' },
  { label: 'Service account', value: 'service_account' },
  { label: 'Trigger', value: 'trigger' },
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

// Convert an ISO datetime (the API's filter format) to the value a
// <input type="datetime-local"> expects (local time, no timezone suffix).
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // datetime-local is "YYYY-MM-DDTHH:mm" in the USER's local zone; toISOString
  // gives UTC, so we read the local components instead.
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Reverse: a datetime-local value (local) → ISO string. '' → '' (no filter).
function fromLocalInput(local: string): string {
  if (!local) return '';
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

// ─── Component ────────────────────────────────────────────────────────────

interface AuditTabProps {
  accountId: string;
}

export function AuditTab({ accountId }: AuditTabProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [filter, setFilter] = useState<AuditFilterState>(EMPTY_FILTER);
  const [exporting, setExporting] = useState(false);
  const [qInput, setQInput] = useState('');

  const hasFilter = !!(
    filter.action ||
    filter.actor ||
    filter.resourceType ||
    filter.q ||
    filter.since ||
    filter.until
  );

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

  // Streams the export with the active filter, triggers a browser download.
  // We use raw fetch instead of backendApi because the response is a file
  // (text/csv or application/x-ndjson), not the JSON wrapper the client
  // helpers assume. Mirrors the list query's filter shape exactly.
  async function exportEvents(format: 'csv' | 'jsonl') {
    setExporting(true);
    try {
      const token = await getSupabaseAccessTokenWithRetry();
      if (!token) {
        errorToast('Not signed in');
        return;
      }
      const result = await downloadAccountAudit(
        accountId,
        {
          format,
          action: filter.action || undefined,
          actor: filter.actor || undefined,
          resource_type: filter.resourceType || undefined,
          q: filter.q || undefined,
          since: filter.since || undefined,
          until: filter.until || undefined,
        },
        {
          backendUrl: getEnv().BACKEND_URL ?? '',
          accessToken: token,
        },
      );

      const downloadUrl = URL.createObjectURL(result.blob);
      const filename =
        result.filename ?? `audit-${new Date().toISOString().slice(0, 10)}.${format}`;
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(downloadUrl);

      const capped = result.capped;
      const rowCount = result.rowCount ?? '?';
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

  // Debounce the free-text search by only committing `qInput` into the query
  // key on Enter / blur — keeps the infinite query from refiring per keystroke.
  const query = useInfiniteQuery({
    queryKey: ['audit', accountId, filter],
    queryFn: ({ pageParam }) =>
      listAuditEvents(accountId, {
        action: filter.action || undefined,
        actor: filter.actor || undefined,
        resource_type: filter.resourceType || undefined,
        q: filter.q || undefined,
        since: filter.since || undefined,
        until: filter.until || undefined,
        cursor: pageParam,
        limit: 50,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });

  const allEvents: IamAuditEvent[] = useMemo(
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
              {exporting ? (
                <Loading className="size-4 shrink-0" />
              ) : (
                <Download className="size-4" />
              )}
              Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onSelect={() => exportEvents('csv')}>Download CSV</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => exportEvents('jsonl')}>
              Download JSONL
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Quick chips — preset the action kind; the structured row below refines. */}
      <FilterBar className="h-auto flex-wrap justify-start">
        {QUICK_FILTERS.map((f) => {
          const activeChip = filter.action === f.action && (f.action !== '' || !hasFilter);
          return (
            <FilterBarItem
              key={f.label}
              onClick={() => setFilter((s) => ({ ...s, action: f.action }))}
              data-state={activeChip ? 'active' : 'inactive'}
            >
              {f.label}
            </FilterBarItem>
          );
        })}
      </FilterBar>

      {/* Structured filter row — actor, resource type, free-text, date range. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2" />
          <Input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setFilter((s) => ({ ...s, q: qInput.trim() }));
            }}
            onBlur={() => setFilter((s) => ({ ...s, q: qInput.trim() }))}
            placeholder="Search actions, resources, IDs…"
            className="h-9 pl-8"
          />
        </div>

        <Select
          value={filter.actor || 'all'}
          onValueChange={(v) => setFilter((s) => ({ ...s, actor: v === 'all' ? '' : v }))}
        >
          <SelectTrigger size="sm" className="h-9 w-[180px]">
            <SelectValue placeholder="Actor" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Everyone</SelectItem>
            {(membersQuery.data ?? []).map((m) => (
              <SelectItem key={m.user_id} value={m.user_id}>
                {m.email ?? m.user_id.slice(0, 8)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={filter.resourceType || 'any'}
          onValueChange={(v) => setFilter((s) => ({ ...s, resourceType: v === 'any' ? '' : v }))}
        >
          <SelectTrigger size="sm" className="h-9 w-[160px]">
            <SelectValue placeholder="Resource" />
          </SelectTrigger>
          <SelectContent>
            {RESOURCE_TYPES.map((r) => (
              <SelectItem key={r.value || 'any'} value={r.value || 'any'}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          type="datetime-local"
          value={filter.since ? toLocalInput(filter.since) : ''}
          onChange={(e) => setFilter((s) => ({ ...s, since: fromLocalInput(e.target.value) }))}
          aria-label="From"
          className="h-9 w-[200px]"
        />
        <Input
          type="datetime-local"
          value={filter.until ? toLocalInput(filter.until) : ''}
          onChange={(e) => setFilter((s) => ({ ...s, until: fromLocalInput(e.target.value) }))}
          aria-label="To"
          className="h-9 w-[200px]"
        />

        {hasFilter && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 gap-1.5"
            onClick={() => {
              setFilter(EMPTY_FILTER);
              setQInput('');
            }}
          >
            <X className="size-4" />
            Clear
          </Button>
        )}
      </div>

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

function AuditRow({ event, actorEmail }: { event: IamAuditEvent; actorEmail: string | null }) {
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
