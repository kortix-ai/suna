'use client';

import {
  CaretRightIcon as CaretRight,
  DownloadIcon as Download,
  FunnelIcon as Funnel,
  MagnifyingGlassIcon as Search,
  XIcon as X,
} from '@phosphor-icons/react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useTranslations } from '@/i18n/use-translations';
import { type Dispatch, type ReactNode, type SetStateAction, useMemo, useState } from 'react';

import { CopyOverlay, HighlightedCode } from '@/components/markdown/code';
import { CopyButton } from '@/components/markdown/copy-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import {
  EMPTY_PRINCIPAL_SELECTION,
  PROJECT_SELECT_ALL,
  PrincipalPicker,
  type PrincipalSelection,
  ProjectSelect,
  formatRelative,
  singlePrincipal,
} from '@/features/workspace/shared/access';
import { localizeUiCatalog, translateUiCatalogText } from '@/i18n/localize-ui-catalog';
import { PRODUCT_CATALOG_TRANSLATION_KEYS } from '@/i18n/product-catalog-translation-keys.generated';
import { getSupabaseAccessTokenWithRetry } from '@/lib/auth-token';
import { getEnv } from '@/lib/env-config';
import { type IamAuditEvent, listAuditEvents } from '@/lib/iam-client';
import { cn } from '@/lib/utils';
import {
  downloadAccountAudit,
  listAccountMembers,
  listProjectSessions,
  listProjectsForAccount,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import {
  type AuditActionDescription,
  type HumanizedAuditAction,
  describeAuditAction,
  formatResourcePill,
} from './audit-display-helpers';

type ActorType = NonNullable<IamAuditEvent['actor_type']>;
type Outcome = NonNullable<IamAuditEvent['outcome']>;

interface AuditFilterState {
  action: string;
  actor: string;
  actorType: ActorType | '';
  projectId: string;
  sessionId: string;
  source: string;
  phase: string;
  outcome: Outcome | '';
  resourceType: string;
  q: string;
  since: string;
  until: string;
}

const EMPTY_FILTER: AuditFilterState = {
  action: '',
  actor: '',
  actorType: '',
  projectId: '',
  sessionId: '',
  source: '',
  phase: '',
  outcome: '',
  resourceType: '',
  q: '',
  since: '',
  until: '',
};

const QUICK_FILTERS: Array<{
  label: string;
  action?: string;
  actorType?: ActorType;
  outcome?: Outcome;
  resourceType?: string;
}> = [
  { label: 'All activity' },
  { label: 'People', actorType: 'human' },
  { label: 'Agents', actorType: 'agent' },
  { label: 'Sessions', resourceType: 'project_session' },
  { label: 'Connectors', action: 'connector.' },
  { label: 'Failures', outcome: 'failure' },
];

const RESOURCE_TYPES = [
  { label: 'Any resource', value: '' },
  { label: 'Project', value: 'project' },
  { label: 'Session', value: 'project_session' },
  { label: 'Connector action', value: 'connector_action' },
  { label: 'Connector approval', value: 'connector_approval' },
  { label: 'Computer connection', value: 'computer_tunnel' },
  { label: 'Secret', value: 'project_secret' },
  { label: 'Group', value: 'group' },
  { label: 'Account', value: 'account' },
  { label: 'Service account', value: 'service_account' },
  { label: 'Trigger', value: 'trigger' },
];

const SOURCES = [
  { label: 'Any source', value: '' },
  { label: 'Human', value: 'human' },
  { label: 'API key', value: 'api_key' },
  { label: 'Agent', value: 'agent' },
  { label: 'OpenCode', value: 'opencode' },
  { label: 'LLM gateway', value: 'llm_gateway' },
  { label: 'Provider', value: 'provider' },
  { label: 'Automation', value: 'automation' },
  { label: 'Connector', value: 'connector' },
  { label: 'Tunnel', value: 'tunnel' },
  { label: 'API', value: 'api' },
  { label: 'CLI client', value: 'cli' },
  { label: 'Web client', value: 'web' },
  { label: 'Mobile client', value: 'mobile' },
];

const PHASES = ['pending', 'queued', 'running', 'completed', 'succeeded', 'failed', 'denied'];

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

function toLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(local: string): string {
  if (!local) return '';
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function isQuickFilterActive(filter: AuditFilterState, preset: (typeof QUICK_FILTERS)[number]) {
  return (
    filter.action === (preset.action ?? '') &&
    filter.actorType === (preset.actorType ?? '') &&
    filter.outcome === (preset.outcome ?? '') &&
    filter.resourceType === (preset.resourceType ?? '')
  );
}

function applyQuickFilter(
  filter: AuditFilterState,
  preset: (typeof QUICK_FILTERS)[number],
): AuditFilterState {
  return {
    ...filter,
    action: preset.action ?? '',
    actorType: preset.actorType ?? '',
    outcome: preset.outcome ?? '',
    resourceType: preset.resourceType ?? '',
  };
}

export function AuditTab({ accountId }: { accountId: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const quickFilters = useMemo(
    () => localizeUiCatalog(QUICK_FILTERS, tI18nComplete, PRODUCT_CATALOG_TRANSLATION_KEYS),
    [tI18nComplete],
  );
  const [filter, setFilter] = useState<AuditFilterState>(EMPTY_FILTER);
  const [qInput, setQInput] = useState('');
  const [exporting, setExporting] = useState(false);

  const membersQuery = useQuery({
    queryKey: ['account-members', accountId],
    queryFn: () => listAccountMembers(accountId),
    staleTime: 30_000,
  });
  // Same key + fetcher `ProjectSelect` uses, so the filter control and the
  // Scope column's name lookup share one round-trip instead of two.
  const projectsQuery = useQuery({
    queryKey: qk.projects.list(accountId),
    queryFn: () => listProjectsForAccount(accountId),
    ...contract('inventory'),
  });
  const sessionsQuery = useQuery({
    queryKey: ['audit-project-sessions', filter.projectId],
    queryFn: () => listProjectSessions(filter.projectId, { scope: 'project' }),
    enabled: !!filter.projectId,
    staleTime: 15_000,
  });

  const emailByUserId = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of membersQuery.data ?? []) {
      if (member.email) map.set(member.user_id, member.email);
    }
    return map;
  }, [membersQuery.data]);
  const projectNameById = useMemo(
    () => new Map((projectsQuery.data ?? []).map((project) => [project.project_id, project.name])),
    [projectsQuery.data],
  );

  const filterCount = [
    filter.actor,
    filter.actorType,
    filter.projectId,
    filter.sessionId,
    filter.source,
    filter.phase,
    filter.outcome,
    filter.resourceType,
    filter.q,
    filter.since,
    filter.until,
    filter.action,
  ].filter(Boolean).length;
  const hasFilter = filterCount > 0;
  const activeQuickFilter = QUICK_FILTERS.find((preset) =>
    isQuickFilterActive(filter, preset),
  )?.label;

  const query = useInfiniteQuery({
    queryKey: ['audit', accountId, filter],
    queryFn: ({ pageParam }) =>
      listAuditEvents(accountId, {
        action: filter.action || undefined,
        actor: filter.actor || undefined,
        actor_type: filter.actorType || undefined,
        project_id: filter.projectId || undefined,
        session_id: filter.sessionId || undefined,
        source: filter.source || undefined,
        phase: filter.phase || undefined,
        outcome: filter.outcome || undefined,
        resource_type: filter.resourceType || undefined,
        q: filter.q || undefined,
        since: filter.since || undefined,
        until: filter.until || undefined,
        cursor: pageParam,
        limit: 50,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
  });

  const events = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.events),
    [query.data],
  );

  async function exportEvents(format: 'csv' | 'jsonl') {
    setExporting(true);
    try {
      const token = await getSupabaseAccessTokenWithRetry();
      if (!token) {
        errorToast(tI18nComplete.raw('textfd518bfaee70'));
        return;
      }
      const chunks: string[] = [];
      let cursor: string | undefined;
      let rowCount = 0;
      let firstPage = true;
      let filename: string | null = null;
      for (;;) {
        const result = await downloadAccountAudit(
          accountId,
          {
            format,
            action: filter.action || undefined,
            actor: filter.actor || undefined,
            actor_type: filter.actorType || undefined,
            project_id: filter.projectId || undefined,
            session_id: filter.sessionId || undefined,
            source: filter.source || undefined,
            phase: filter.phase || undefined,
            outcome: filter.outcome || undefined,
            resource_type: filter.resourceType || undefined,
            q: filter.q || undefined,
            since: filter.since || undefined,
            until: filter.until || undefined,
            cursor,
          },
          { backendUrl: getEnv().BACKEND_URL ?? '', accessToken: token },
        );
        filename ??= result.filename;
        rowCount += Number(result.rowCount ?? 0);
        let chunk = await result.blob.text();
        if (format === 'csv' && !firstPage) chunk = chunk.replace(/^[^\r\n]*(?:\r?\n|$)/, '');
        if (chunk) chunks.push(chunk.replace(/\s+$/, ''));
        firstPage = false;
        if (result.complete) break;
        if (!result.nextCursor || result.nextCursor === cursor) {
          throw new Error('Export returned an invalid continuation cursor');
        }
        cursor = result.nextCursor;
      }

      const blob = new Blob([chunks.join('\n')], {
        type: format === 'csv' ? 'text/csv' : 'application/x-ndjson',
      });
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = filename ?? `audit-${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(downloadUrl);
      successToast(tI18nComplete('text7c994b5261dc', { value0: rowCount }));
    } catch (error) {
      errorToast((error as Error).message || tI18nComplete.raw('texte94d3ee06ecf'));
    } finally {
      setExporting(false);
    }
  }

  function clearFilters() {
    setFilter(EMPTY_FILTER);
    setQInput('');
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-foreground text-sm font-medium">
            {tI18nComplete.raw('texte4d36f9a4e22')}
          </p>
          <p className="text-muted-foreground max-w-2xl text-xs leading-relaxed">
            {tI18nComplete.raw('text862397da3718')}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="sm" disabled={exporting} className="gap-1.5">
              {exporting ? <Loading className="size-4" /> : <Download className="size-4" />}
              {tI18nComplete.raw('text3664895579f0')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onSelect={() => exportEvents('csv')}>
              {tI18nComplete.raw('texta4023b89022f')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => exportEvents('jsonl')}>
              {tI18nComplete.raw('text3e01503c5c75')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Tabs
        value={activeQuickFilter}
        onValueChange={(value) => {
          const preset = QUICK_FILTERS.find((item) => item.label === value);
          if (preset) setFilter((current) => applyQuickFilter(current, preset));
        }}
      >
        <TabsList type="underline" className="h-auto w-full flex-wrap justify-start">
          {quickFilters.map((preset) => (
            <TabsTrigger key={preset.label} value={preset.label} className="w-fit flex-none pb-3">
              {preset.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            value={qInput}
            onChange={(event) => setQInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Enter') {
                setFilter((current) => ({ ...current, q: qInput.trim() }));
              }
            }}
            onBlur={() => setFilter((current) => ({ ...current, q: qInput.trim() }))}
            placeholder={tI18nComplete.raw('text03f856a9d7ec')}
            aria-label={tI18nComplete.raw('textfc856a631771')}
            className="h-9 pl-8"
          />
        </div>

        <ProjectSelect
          accountId={accountId}
          value={filter.projectId || PROJECT_SELECT_ALL}
          allOptionLabel={tI18nComplete.raw('text4b87271b6b81')}
          placeholder={tI18nComplete.raw('text985959785319')}
          className="h-9 w-[210px]"
          onChange={(value) =>
            setFilter((current) => ({
              ...current,
              projectId: value === PROJECT_SELECT_ALL ? '' : value,
              sessionId: '',
            }))
          }
        />

        <Select
          value={filter.sessionId || 'all'}
          disabled={!filter.projectId}
          onValueChange={(value) =>
            setFilter((current) => ({
              ...current,
              sessionId: value === 'all' ? '' : value,
            }))
          }
        >
          <SelectTrigger size="sm" className="h-9 w-[220px]">
            <SelectValue
              placeholder={
                filter.projectId
                  ? tI18nComplete.raw('text78648d4d6649')
                  : tI18nComplete.raw('textf7b9225a1fdc')
              }
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{tI18nComplete.raw('text78648d4d6649')}</SelectItem>
            {(sessionsQuery.data ?? []).map((session) => (
              <SelectItem
                key={session.session_id}
                value={session.session_id}
                description={session.session_id}
              >
                {session.name || `Session ${session.session_id.slice(0, 8)}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <AdvancedFilters
          accountId={accountId}
          filter={filter}
          onChange={setFilter}
          count={filterCount}
        />

        {hasFilter ? (
          <Button variant="ghost" size="sm" className="h-9 gap-1.5" onClick={clearFilters}>
            <X className="size-4" />
            {tI18nComplete.raw('text83b12c2216ef')}
          </Button>
        ) : null}
      </div>

      {query.isError ? (
        <ErrorState
          size="sm"
          title={tI18nComplete.raw('text73a3f2fca157')}
          description={(query.error as Error)?.message}
          action={
            <Button variant="outline" size="sm" onClick={() => query.refetch()}>
              {tI18nComplete.raw('text942087cc2d41')}
            </Button>
          }
        />
      ) : null}

      {query.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-14 w-full rounded-md" />
          ))}
        </div>
      ) : null}

      {!query.isLoading && !query.isError && events.length === 0 ? (
        <EmptyState
          icon={Search}
          size="sm"
          title={tI18nComplete.raw('text046aea06df37')}
          description={tI18nComplete.raw('text380efe8cc760')}
        />
      ) : null}

      {!query.isLoading && !query.isError && events.length > 0 ? (
        <div className="border-border overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{tI18nComplete.raw('text4e1f49a9c8ae')}</TableHead>
                <TableHead>{tI18nComplete.raw('textb073f6c68ef8')}</TableHead>
                <TableHead>{tI18nComplete.raw('textafc19f1734c1')}</TableHead>
                <TableHead>{tI18nComplete.raw('text6e7d50e84f47')}</TableHead>
                <TableHead className="hidden text-right 2xl:table-cell">
                  {tI18nComplete.raw('text33b93476cf59')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => (
                <AuditRow
                  key={event.event_id}
                  event={event}
                  actorEmail={
                    event.actor_user_id ? (emailByUserId.get(event.actor_user_id) ?? null) : null
                  }
                  projectName={
                    event.project_id ? (projectNameById.get(event.project_id) ?? null) : null
                  }
                />
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      {query.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            className="gap-1.5"
          >
            {query.isFetchingNextPage ? <Loading className="size-3.5" /> : null}
            {tI18nComplete.raw('textac8991ef0101')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function AdvancedFilters({
  accountId,
  filter,
  onChange,
  count,
}: {
  accountId: string;
  filter: AuditFilterState;
  onChange: Dispatch<SetStateAction<AuditFilterState>>;
  count: number;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  // `filter.actor` is a user id on the wire; the picker speaks
  // `PrincipalSelection`, so the field is derived from the filter rather than
  // held twice — clearing the filter clears the picker with no extra wiring.
  const actorSelection: PrincipalSelection = filter.actor
    ? { ...EMPTY_PRINCIPAL_SELECTION, memberIds: [filter.actor] }
    : EMPTY_PRINCIPAL_SELECTION;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 gap-1.5">
          <Funnel className="size-4" />
          {tI18nComplete.raw('text546ebb8eb993')}
          {count > 0 ? (
            <Badge variant="muted" size="xs" className="ml-0.5 tabular-nums">
              {count}
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(44rem,calc(100vw-2rem))] space-y-4 p-4">
        <div>
          <p className="text-foreground text-sm font-medium">
            {tI18nComplete.raw('text3b9995d82ed9')}
          </p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {tI18nComplete.raw('text4fc200eed435')}
          </p>
        </div>
        {/* "Who" leads, full width: the picker is a searchable list, not a
            one-line Select, so it would blow out a grid row's height. */}
        <FilterField
          label={tI18nComplete.raw('text6007db63e18e')}
          plain
          action={
            filter.actor ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => onChange((current) => ({ ...current, actor: '' }))}
              >
                {tI18nComplete.raw('textda2e5dc515b1')}
              </Button>
            ) : null
          }
        >
          <PrincipalPicker
            scope={{ kind: 'account', accountId }}
            selection="single"
            kinds={['member']}
            value={actorSelection}
            autoFocus={false}
            emptyLabel={tI18nComplete.raw('text0f8c1078fa99')}
            onChange={(next) => {
              const picked = singlePrincipal(next);
              onChange((current) => ({
                ...current,
                actor: picked?.kind === 'member' ? picked.id : '',
              }));
            }}
          />
        </FilterField>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <FilterField label={tI18nComplete.raw('text104a6fe5d2a6')}>
            <Select
              value={filter.actorType || 'all'}
              onValueChange={(value) =>
                onChange((current) => ({
                  ...current,
                  actorType: value === 'all' ? '' : (value as ActorType),
                }))
              }
            >
              <SelectTrigger size="sm" className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tI18nComplete.raw('texteb9e6d4103b1')}</SelectItem>
                <SelectItem value="human">{tI18nComplete.raw('text6007db63e18e')}</SelectItem>
                <SelectItem value="agent">{tI18nComplete.raw('text11b39c93777e')}</SelectItem>
                <SelectItem value="service_account">
                  {tI18nComplete.raw('textce5e9df4a78f')}
                </SelectItem>
                <SelectItem value="system">{tI18nComplete.raw('text6725e7bbcd28')}</SelectItem>
              </SelectContent>
            </Select>
          </FilterField>

          <FilterField label={tI18nComplete.raw('text0e570ca6fabe')}>
            <Select
              value={filter.source || 'all'}
              onValueChange={(value) =>
                onChange((current) => ({
                  ...current,
                  source: value === 'all' ? '' : value,
                }))
              }
            >
              <SelectTrigger size="sm" className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {localizeUiCatalog(SOURCES, tI18nComplete, PRODUCT_CATALOG_TRANSLATION_KEYS).map(
                  (source) => (
                    <SelectItem key={source.value || 'all'} value={source.value || 'all'}>
                      {source.label}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </FilterField>

          <FilterField label={tI18nComplete.raw('text4e80abb5b146')}>
            <Select
              value={filter.outcome || 'all'}
              onValueChange={(value) =>
                onChange((current) => ({
                  ...current,
                  outcome: value === 'all' ? '' : (value as Outcome),
                }))
              }
            >
              <SelectTrigger size="sm" className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tI18nComplete.raw('textae47e08e55f1')}</SelectItem>
                <SelectItem value="success">{tI18nComplete.raw('textc88a0b907419')}</SelectItem>
                <SelectItem value="pending">{tI18nComplete.raw('text331551b0de41')}</SelectItem>
                <SelectItem value="denied">{tI18nComplete.raw('textda404deb110f')}</SelectItem>
                <SelectItem value="failure">{tI18nComplete.raw('text7031edbcf9c4')}</SelectItem>
              </SelectContent>
            </Select>
          </FilterField>

          <FilterField label={tI18nComplete.raw('text46342ec1eec9')}>
            <Select
              value={filter.phase || 'all'}
              onValueChange={(value) =>
                onChange((current) => ({
                  ...current,
                  phase: value === 'all' ? '' : value,
                }))
              }
            >
              <SelectTrigger size="sm" className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tI18nComplete.raw('text0154297a0f48')}</SelectItem>
                {PHASES.map((phase) => (
                  <SelectItem key={phase} value={phase}>
                    {translateUiCatalogText(
                      phase.charAt(0).toUpperCase() + phase.slice(1),
                      tI18nComplete,
                      PRODUCT_CATALOG_TRANSLATION_KEYS,
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>

          <FilterField label={tI18nComplete.raw('texteb7a842ff958')}>
            <Select
              value={filter.resourceType || 'all'}
              onValueChange={(value) =>
                onChange((current) => ({
                  ...current,
                  resourceType: value === 'all' ? '' : value,
                }))
              }
            >
              <SelectTrigger size="sm" className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {localizeUiCatalog(
                  RESOURCE_TYPES,
                  tI18nComplete,
                  PRODUCT_CATALOG_TRANSLATION_KEYS,
                ).map((resource) => (
                  <SelectItem key={resource.value || 'all'} value={resource.value || 'all'}>
                    {resource.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>

          <FilterField label={tI18nComplete.raw('text218197693424')}>
            <Input
              type="datetime-local"
              value={filter.since ? toLocalInput(filter.since) : ''}
              onChange={(event) =>
                onChange((current) => ({
                  ...current,
                  since: fromLocalInput(event.target.value),
                }))
              }
              className="h-9 w-full"
            />
          </FilterField>

          <FilterField label={tI18nComplete.raw('textf4b06ef6d3c8')}>
            <Input
              type="datetime-local"
              value={filter.until ? toLocalInput(filter.until) : ''}
              onChange={(event) =>
                onChange((current) => ({
                  ...current,
                  until: fromLocalInput(event.target.value),
                }))
              }
              className="h-9 w-full"
            />
          </FilterField>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function FilterField({
  label,
  children,
  action,
  // A `<label>` may not wrap a composite widget with its own search input and
  // row buttons — the Person picker renders in a plain `<div>` instead.
  plain = false,
  className,
}: {
  label: string;
  children: ReactNode;
  action?: ReactNode;
  plain?: boolean;
  className?: string;
}) {
  const Wrapper = plain ? 'div' : 'label';
  return (
    <Wrapper className={cn('block space-y-1.5', className)}>
      <span
        className={cn(
          'text-muted-foreground block text-xs font-medium',
          action && 'flex min-h-6 items-center justify-between gap-2',
        )}
      >
        {label}
        {action}
      </span>
      {children}
    </Wrapper>
  );
}

function AuditRow({
  event,
  actorEmail,
  projectName,
}: {
  event: IamAuditEvent;
  actorEmail: string | null;
  projectName: string | null;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [expanded, setExpanded] = useState(false);
  const occurred = new Date(event.occurred_at);
  const action = describeAuditAction(event.action, tI18nComplete);
  const resource = formatResourcePill(event.resource_type, event.resource_id);
  const actorLabel =
    actorEmail ?? event.actor_user_id ?? (event.actor_type === 'system' ? 'System' : 'Unknown');
  const scopeLabel =
    projectName ?? (event.project_id ? `Project ${event.project_id.slice(0, 8)}` : 'Account');

  return (
    <>
      <TableRow
        className="cursor-pointer"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        onKeyDown={(keyboardEvent) => {
          if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') {
            keyboardEvent.preventDefault();
            setExpanded((value) => !value);
          }
        }}
      >
        <TableCell className="max-w-[360px] py-3 whitespace-normal">
          <div className="flex min-w-0 items-start gap-2">
            <CaretRight
              className={cn(
                'text-muted-foreground duration-normal mt-0.5 size-3.5 shrink-0 transition-transform',
                expanded && 'rotate-90',
              )}
            />
            <span
              className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', KIND_DOT_TOKEN[action.kind])}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-foreground truncate text-sm font-medium">{action.title}</span>
                {action.detail ? (
                  <code className="bg-muted/50 text-muted-foreground truncate rounded px-1.5 py-0.5 font-mono text-xs">
                    {action.detail}
                  </code>
                ) : null}
              </div>
              {action.method || action.area ? (
                <div className="mt-1 flex min-w-0 items-center gap-1.5">
                  {action.method && action.mapped ? (
                    <Badge variant="outline" size="xs" className="font-mono font-medium">
                      {action.method}
                    </Badge>
                  ) : null}
                  <span className="text-muted-foreground truncate text-xs">
                    {action.mapped ? action.area : tI18nComplete.raw('text82a01c0069b6')}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        </TableCell>
        <TableCell className="max-w-[220px] whitespace-normal">
          <p className="text-foreground truncate text-xs">{scopeLabel}</p>
          {event.session_id ? (
            <p className="text-muted-foreground truncate font-mono text-xs">
              {tI18nComplete.raw('text6959b4159575')} {event.session_id.slice(0, 8)}
            </p>
          ) : null}
        </TableCell>
        <TableCell className="max-w-[220px] whitespace-normal">
          <p className="text-foreground truncate text-xs">{actorLabel}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {event.actor_type ? (
              <Badge variant="muted" size="xs" className="capitalize">
                {event.actor_type.replace('_', ' ')}
              </Badge>
            ) : null}
            {event.authoritative_source || event.source ? (
              <Badge variant="outline" size="xs" className="capitalize">
                {(event.authoritative_source ?? event.source ?? '').replace('_', ' ')}
              </Badge>
            ) : null}
            {event.client_reported_source ? (
              <Badge variant="muted" size="xs" className="capitalize">
                {tI18nComplete.raw('texta273a74aed9f')}{' '}
                {event.client_reported_source.replace('_', ' ')}
              </Badge>
            ) : null}
          </div>
        </TableCell>
        <TableCell>
          <OutcomeBadge outcome={event.outcome} status={event.http_status} />
        </TableCell>
        <TableCell
          className="text-muted-foreground hidden text-right text-xs tabular-nums 2xl:table-cell"
          title={occurred.toLocaleString()}
        >
          {formatRelative(occurred)}
        </TableCell>
      </TableRow>
      {expanded ? (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={5} className="bg-muted/10 p-0 whitespace-normal">
            <div className="space-y-4 p-4 md:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <p className="text-muted-foreground text-xs font-medium">
                    {tI18nComplete.raw('text097e77abc2d0')}
                  </p>
                  <p className="text-foreground text-sm font-medium">{action.title}</p>
                  <p className="text-muted-foreground text-xs">
                    {occurred.toLocaleString()} · {actorLabel}
                  </p>
                </div>
                <OutcomeBadge outcome={event.outcome} status={event.http_status} />
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                <RequestPanel action={action} rawAction={event.action} />
                <ResourcePanel
                  resource={resource}
                  resourceId={event.resource_id}
                  projectName={projectName}
                  sessionId={event.session_id}
                />
              </div>

              <div className="border-border bg-background grid overflow-hidden rounded-md border sm:grid-cols-2 lg:grid-cols-4">
                <Detail label={tI18nComplete.raw('text3045abafb173')} value={event.event_id} />
                <Detail
                  label={tI18nComplete.raw('textc831393117f0')}
                  value={event.session_sequence != null ? String(event.session_sequence) : null}
                />
                <Detail label={tI18nComplete.raw('text46342ec1eec9')} value={event.phase ?? null} />
                <Detail
                  label={tI18nComplete.raw('textdc8d7c5c602b')}
                  value={event.source_ledger ?? null}
                />
                <Detail label={tI18nComplete.raw('textd561f528baf7')} value={event.request_id} />
                <Detail label={tI18nComplete.raw('textc4cbbc62b684')} value={event.trace_id} />
                <Detail
                  label={tI18nComplete.raw('textc267c186e80d')}
                  value={event.correlation_id}
                />
                <Detail
                  label={tI18nComplete.raw('texta679a097d834')}
                  value={event.causation_id ?? null}
                />
                <Detail label={tI18nComplete.raw('texte511470b21a9')} value={event.project_id} />
                <Detail label={tI18nComplete.raw('textcb9ac5c561da')} value={event.session_id} />
                <Detail
                  label={tI18nComplete.raw('text5a26f4425c82')}
                  value={event.opencode_session_id ?? null}
                />
                <Detail
                  label={tI18nComplete.raw('textef54a62ae880')}
                  value={event.turn_id ?? null}
                />
                <Detail
                  label={tI18nComplete.raw('text11d5959da5d3')}
                  value={event.message_id ?? null}
                />
                <Detail
                  label={tI18nComplete.raw('textfce8323af972')}
                  value={event.tool_call_id ?? null}
                />
                <Detail
                  label={tI18nComplete.raw('texte8c80b20c2f7')}
                  value={event.execution_id ?? null}
                />
                <Detail
                  label={tI18nComplete.raw('text4fc52a3c4c55')}
                  value={event.duration_ms != null ? `${event.duration_ms} ms` : null}
                />
                <Detail
                  label={tI18nComplete.raw('text9fe54d716290')}
                  value={occurred.toISOString()}
                />
              </div>

              {event.before !== null || event.after !== null ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <JsonPane label={tI18nComplete.raw('text9bb725005055')} data={event.before} />
                  <JsonPane label={tI18nComplete.raw('text7b68fe551085')} data={event.after} />
                </div>
              ) : null}
              {event.input_summary || event.output_summary ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <JsonPane
                    label={tI18nComplete.raw('textef62ef5cacd2')}
                    data={event.input_summary}
                  />
                  <JsonPane
                    label={tI18nComplete.raw('text186c238a4d46')}
                    data={event.output_summary}
                  />
                </div>
              ) : null}
              {event.input_sha256 || event.output_sha256 || event.integrity_hash ? (
                <div className="border-border bg-background grid overflow-hidden rounded-md border sm:grid-cols-3">
                  <Detail
                    label={tI18nComplete.raw('text3b4a27ee118e')}
                    value={event.input_sha256 ?? null}
                  />
                  <Detail
                    label={tI18nComplete.raw('text05dcf5ae7043')}
                    value={event.output_sha256 ?? null}
                  />
                  <Detail
                    label={tI18nComplete.raw('text826c8e46dc22')}
                    value={event.integrity_hash ?? null}
                  />
                </div>
              ) : null}
              {event.metadata && Object.keys(event.metadata).length > 0 ? (
                <JsonPane label={tI18nComplete.raw('text9eddf573cb50')} data={event.metadata} />
              ) : null}
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function OutcomeBadge({
  outcome,
  status,
}: {
  outcome: IamAuditEvent['outcome'];
  status: number | null;
}) {
  if (!outcome) {
    return status != null ? (
      <Badge variant="muted" size="xs" className="tabular-nums">
        {status}
      </Badge>
    ) : (
      <span className="text-muted-foreground text-xs">—</span>
    );
  }
  const variant: 'success' | 'warning' | 'destructive' | 'muted' =
    outcome === 'success'
      ? 'success'
      : outcome === 'pending'
        ? 'warning'
        : outcome === 'denied' || outcome === 'failure'
          ? 'destructive'
          : 'muted';
  return (
    <Badge variant={variant} size="xs" className="capitalize">
      {outcome}
      {status != null ? ` · ${status}` : ''}
    </Badge>
  );
}

function RequestPanel({
  action,
  rawAction,
}: {
  action: AuditActionDescription;
  rawAction: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="border-border bg-background overflow-hidden rounded-md border">
      <div className="border-border flex min-h-10 items-center justify-between gap-3 border-b px-3 py-2">
        <p className="text-muted-foreground text-xs font-medium">
          {tI18nComplete.raw('text59f03d642b41')}
        </p>
        <div className="flex min-w-0 items-center gap-1.5">
          {action.method ? (
            <Badge variant="outline" size="xs" className="font-mono font-medium">
              {action.method}
            </Badge>
          ) : null}
          {action.area ? (
            <span className="text-muted-foreground truncate text-xs">{action.area}</span>
          ) : null}
        </div>
      </div>
      <div className="space-y-2 p-3">
        {action.route ? (
          <code className="text-foreground block font-mono text-xs break-all">{action.route}</code>
        ) : null}
        <div className="bg-muted/30 flex min-h-10 items-center gap-2 rounded-md px-2.5">
          <code className="text-muted-foreground min-w-0 flex-1 font-mono text-xs break-all">
            {rawAction}
          </code>
          <CopyButton code={rawAction} className="size-10 shrink-0" />
        </div>
      </div>
    </div>
  );
}

function ResourcePanel({
  resource,
  resourceId,
  projectName,
  sessionId,
}: {
  resource: string | null;
  resourceId: string | null;
  projectName: string | null;
  sessionId: string | null;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="border-border bg-background overflow-hidden rounded-md border">
      <div className="border-border flex min-h-10 items-center border-b px-3 py-2">
        <p className="text-muted-foreground text-xs font-medium">
          {tI18nComplete.raw('text88134334f4c6')}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 p-3">
        <SummaryValue label={tI18nComplete.raw('texteb7a842ff958')} value={resource} />
        <SummaryValue label={tI18nComplete.raw('text985959785319')} value={projectName} />
        <SummaryValue label={tI18nComplete.raw('textdb5f2f038452')} value={resourceId} mono />
        <SummaryValue label={tI18nComplete.raw('textcb9ac5c561da')} value={sessionId} mono />
      </div>
    </div>
  );
}

function SummaryValue({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-muted-foreground text-xs font-medium">{label}</p>
      <p
        className={cn(
          'text-foreground text-xs break-all',
          mono && 'font-mono text-xs tabular-nums',
        )}
      >
        {value ?? '—'}
      </p>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="border-border min-w-0 space-y-1 border-b p-3 last:border-b-0 sm:border-r sm:nth-[2n]:border-r-0 sm:nth-last-[-n+2]:border-b-0 lg:nth-[2n]:border-r lg:nth-[4n]:border-r-0 lg:nth-last-[-n+4]:border-b-0">
      <p className="text-muted-foreground text-xs font-medium">{label}</p>
      <p
        className="text-foreground font-mono text-xs break-all tabular-nums"
        title={value ?? undefined}
      >
        {value ?? '—'}
      </p>
    </div>
  );
}

function JsonPane({ label, data }: { label: string; data: unknown }) {
  const code = data === null ? 'null' : JSON.stringify(data, null, 2);
  return (
    <div className="border-border bg-background overflow-hidden rounded-md border">
      <div className="border-border flex min-h-10 items-center justify-between border-b px-3 py-2">
        <p className="text-muted-foreground text-xs font-medium">{label}</p>
        <Badge variant="muted" size="xs" className="font-mono">
          JSON
        </Badge>
      </div>
      <CopyOverlay code={code}>
        {/* The capped scroller sits inside the overlay so the copy button stays
            pinned while the JSON scrolls. `HighlightedCode` hardcodes
            `text-sm leading-[1.65]` on its own `<code>`; a `[&_code]:` selector
            is one specificity step above that class, so this pane's smaller type
            wins without `!important`. */}
        <div className="max-h-64 overflow-auto p-3 [&_code]:text-xs [&_code]:leading-relaxed">
          <HighlightedCode code={code} language="json" />
        </div>
      </CopyOverlay>
    </div>
  );
}
