'use client';

import type { CaptureWorkflowQuery, CaptureWorkflowStatus } from '@kortix/sdk';
import { useCaptureOverview, useCaptureWorkflows } from '@kortix/sdk/react';
import { DownloadSimpleIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ErrorState } from '@/features/layout/section/error-state';
import { useLocale, useTranslations } from '@/i18n/use-translations';

import { CapturePage } from '../area/capture-area-shell';
import { captureHref, useCaptureArea, useCaptureRange } from '../area/use-capture-area';
import { ExportModal } from '../intelligence/export-modal';
import {
  LearningState,
  ShareBar,
  WorkflowStatusBadge,
  useHours,
  usePercent,
  useRunDuration,
} from '../intelligence/workflow-ui';

type StatusFilter = 'all' | CaptureWorkflowStatus;
const STATUSES: readonly StatusFilter[] = ['all', 'detected', 'reviewed', 'exported'];
const SORTS: readonly NonNullable<CaptureWorkflowQuery['sort']>[] = ['hours', 'runs', 'newest'];
const ALL_APPS = '__all';

/**
 * Workflows (`/capture/[accountId]/workflows`), Capture admins and viewers:
 * every procedure found across the organization, sorted by the hours a week
 * an agent could take. Filters live in the URL, so a link from the overview
 * ("Review 5 detected workflows") lands filtered.
 */
export function WorkflowsView({ accountId }: { accountId: string }) {
  const t = useTranslations('capture.workflows');
  const area = useCaptureArea(accountId);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const range = useCaptureRange();
  const status = (STATUSES as readonly string[]).includes(params.get('status') ?? '')
    ? (params.get('status') as StatusFilter)
    : 'all';
  const sort = (SORTS as readonly string[]).includes(params.get('sort') ?? '')
    ? (params.get('sort') as NonNullable<CaptureWorkflowQuery['sort']>)
    : 'hours';
  const app = params.get('app') ?? ALL_APPS;
  const [input, setInput] = useState(params.get('q') ?? '');
  const [q, setQ] = useState(input.trim());
  useEffect(() => {
    const id = setTimeout(() => setQ(input.trim()), 250);
    return () => clearTimeout(id);
  }, [input]);
  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const member = area.role === 'member';
  useEffect(() => {
    if (member) router.replace(captureHref(accountId, 'devices'));
  }, [member, accountId, router]);

  const list = useCaptureWorkflows(member ? null : accountId, {
    status: status === 'all' ? undefined : status,
    q: q || undefined,
    app: app === ALL_APPS ? undefined : app,
    sort,
    limit: 200,
  });
  const overview = useCaptureOverview(member ? null : accountId, range.window);
  const [exportOpen, setExportOpen] = useState(false);
  const rows = list.data?.workflows ?? [];
  const counts = list.data?.counts;
  // Apps to filter by: every app in the unfiltered list's rows once loaded.
  const [apps, setApps] = useState<string[]>([]);
  const seen = useMemo(() => [...new Set(rows.flatMap((w) => w.apps))].sort(), [rows]);
  if (seen.some((a) => !apps.includes(a))) setApps([...new Set([...apps, ...seen])].sort());
  const filtered = status !== 'all' || !!q || app !== ALL_APPS;

  if (member || !area.role) return null;
  return (
    <CapturePage
      title={t('title')}
      description={counts ? t('description', { count: counts.all }) : null}
      actions={
        area.isAdmin ? (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setExportOpen(true)}
          >
            <DownloadSimpleIcon className="size-3.5 shrink-0" />
            {t('export')}
          </Button>
        ) : null
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-full max-w-sm min-w-0 flex-1">
          <InputGroupSearch>
            <InputGroupSearchIcon>
              <MagnifyingGlassIcon />
            </InputGroupSearchIcon>
            <InputGroupSearchInput
              aria-label={t('searchLabel')}
              placeholder={t('searchPlaceholder')}
              value={input}
              onChange={(event) => setInput(event.target.value)}
            />
            {input ? <InputGroupSearchClear onClick={() => setInput('')} /> : null}
          </InputGroupSearch>
        </div>
        <Tabs
          value={status}
          onValueChange={(value) => setParam('status', value === 'all' ? null : value)}
        >
          <TabsList aria-label={t('statusLabel')}>
            {STATUSES.map((value) => (
              <TabsTrigger key={value} value={value} className="gap-1.5">
                {value === 'all' ? t('all') : t(`status.${value}`)}
                <span className="text-muted-foreground tabular-nums">
                  {counts ? counts[value] : '–'}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select
            value={app}
            onValueChange={(value) => setParam('app', value === ALL_APPS ? null : value)}
          >
            <SelectTrigger size="sm" className="w-36" aria-label={t('appLabel')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value={ALL_APPS}>{t('allApps')}</SelectItem>
              {apps.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={sort}
            onValueChange={(value) => setParam('sort', value === 'hours' ? null : value)}
          >
            <SelectTrigger size="sm" className="w-44" aria-label={t('sortLabel')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {SORTS.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`sort.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <section
        aria-label={t('listLabel')}
        className="bg-background overflow-hidden rounded-md border"
      >
        {list.isLoading ? (
          <div className="space-y-2 px-4 py-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-11 rounded-md" />
            ))}
          </div>
        ) : list.isError ? (
          <div className="px-4 py-10">
            <ErrorState
              size="sm"
              title={t('loadFailed')}
              action={
                <Button variant="outline" size="sm" onClick={() => list.refetch()}>
                  {t('tryAgain')}
                </Button>
              }
            />
          </div>
        ) : counts?.all === 0 ? (
          <div className="px-4 py-14">
            <LearningState hoursRecorded={overview.data?.hours_recorded ?? null} />
          </div>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground px-3 py-10 text-center text-xs">
            {filtered ? t('noMatch') : t('learning.title')}
          </p>
        ) : (
          <WorkflowTable accountId={accountId} rows={rows} />
        )}
        {counts && counts.all > 0 ? (
          <div className="text-muted-foreground flex flex-wrap justify-between gap-3 border-t px-4 py-3 text-xs">
            <span className="tabular-nums">
              {t('showing', { shown: rows.length, total: counts.all })}
            </span>
            <span>{t('formula')}</span>
          </div>
        ) : null}
      </section>
      {area.isAdmin ? (
        <ExportModal
          accountId={accountId}
          open={exportOpen}
          onOpenChange={setExportOpen}
          window={range.window}
        />
      ) : null}
    </CapturePage>
  );
}

function WorkflowTable({
  accountId,
  rows,
}: {
  accountId: string;
  rows: NonNullable<ReturnType<typeof useCaptureWorkflows>['data']>['workflows'];
}) {
  const t = useTranslations('capture.workflows');
  const locale = useLocale();
  const duration = useRunDuration();
  const hours = useHours();
  const percent = usePercent();
  const max = Math.max(...rows.map((r) => r.automation_hours_per_week));
  const grid =
    'grid grid-cols-[minmax(14rem,1fr)_4.5rem_4.5rem_5.5rem_minmax(9rem,12rem)_9rem_7.5rem] items-center gap-4';
  return (
    <div className="overflow-x-auto">
      <div className="min-w-5xl">
        <div className={`${grid} text-muted-foreground border-b px-4 py-2 text-xs`}>
          <span>{t('col.workflow')}</span>
          <span className="text-right">{t('col.runs')}</span>
          <span className="text-right">{t('col.typical')}</span>
          <span>{t('col.people')}</span>
          <span>{t('col.apps')}</span>
          <span>{t('col.automation')}</span>
          <span>{t('col.status')}</span>
        </div>
        <ul>
          {rows.map((w) => (
            <li key={w.workflow_id} className="border-b last:border-b-0">
              <Link
                href={captureHref(accountId, 'workflows', `/${w.workflow_id}`)}
                className={`${grid} hover:bg-hover px-4 py-3 transition-colors`}
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-foreground truncate text-sm font-medium">{w.name}</span>
                  <span className="text-muted-foreground truncate text-xs">
                    {t('rowMeta', {
                      steps: w.steps_count,
                      variants: w.variants_count,
                      first: w.first_seen_at
                        ? new Date(w.first_seen_at).toLocaleDateString(locale, {
                            day: 'numeric',
                            month: 'short',
                          })
                        : '–',
                    })}
                  </span>
                </span>
                <span className="text-right font-mono text-sm tabular-nums">
                  {Math.round(w.runs_per_week)}
                </span>
                <span className="text-right font-mono text-sm tabular-nums">
                  {duration(w.duration_p50_s)}
                </span>
                <span className="text-muted-foreground text-xs">
                  {t('people', { count: w.people_count })}
                </span>
                <span className="flex flex-wrap gap-1">
                  {w.apps.slice(0, 4).map((name) => (
                    <Badge key={name} variant="muted" size="sm" className="normal-case">
                      {name}
                    </Badge>
                  ))}
                </span>
                <span className="flex flex-col gap-1">
                  <span className="flex justify-between gap-2 text-xs">
                    <span className="text-foreground font-mono font-medium tabular-nums">
                      {t('perWeekShort', { hours: hours(w.automation_hours_per_week) })}
                    </span>
                    <span className="text-muted-foreground font-mono tabular-nums">
                      {t('determinismShort', { value: percent(w.determinism) })}
                    </span>
                  </span>
                  <ShareBar value={w.automation_hours_per_week} max={max} />
                </span>
                <span>
                  <WorkflowStatusBadge status={w.status} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
