'use client';

import {
  AppWindowIcon,
  BankIcon,
  ChatCircleIcon,
  EyeSlashIcon,
  GlobeIcon,
  KeyIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  ShieldCheckIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  InputGroupSearch,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorToast } from '@/components/ui/toast';
import { ErrorState } from '@/features/layout/section/error-state';
import { useTranslations } from '@/i18n/use-translations';
import {
  desktopCaptureAppIcon,
  desktopCaptureExclude,
  desktopCaptureExclusions,
  isDesktop,
  type DesktopCaptureExclusion,
  type DesktopCaptureExclusions,
} from '@/lib/desktop';

import {
  applyExclusion,
  exclusionLists,
  normalizeDomain,
  type ExclusionRow,
  type ExclusionTab,
} from './capture-exclusions-model';
import { CaptureRowSection } from './capture-rows';

const EXCLUSIONS_KEY = ['desktop-capture-exclusions'] as const;

const GROUP_ICONS: Record<string, Icon> = {
  password_managers: KeyIcon,
  messaging: ChatCircleIcon,
  banking: BankIcon,
};

/**
 * "This computer" ▸ Exclusions: apps and websites Kortix Capture never records
 * on this computer (no screenshot, no text, no actions). Categories, what is
 * excluded, and what was recorded lately, each one checkbox. A category or an
 * item the organization set is locked. Every toggle applies at once and rolls
 * back with the engine's message when it fails.
 */
export function CaptureExclusions({ org }: { org: string }) {
  const t = useTranslations('capture.dialog.exclusions');
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<ExclusionTab>('apps');
  const [query, setQuery] = useState('');
  const exclusions = useQuery({
    queryKey: EXCLUSIONS_KEY,
    queryFn: async () => (await desktopCaptureExclusions()) ?? null,
    enabled: isDesktop(),
    refetchInterval: 30_000,
  });
  const change = useMutation({
    mutationFn: desktopCaptureExclude,
    onMutate: async (input: DesktopCaptureExclusion) => {
      await queryClient.cancelQueries({ queryKey: EXCLUSIONS_KEY });
      const before = queryClient.getQueryData<DesktopCaptureExclusions | null>(EXCLUSIONS_KEY);
      if (before) queryClient.setQueryData(EXCLUSIONS_KEY, applyExclusion(before, input));
      return { before };
    },
    onError: (error: Error, _input, context) => {
      if (context?.before) queryClient.setQueryData(EXCLUSIONS_KEY, context.before);
      errorToast(error.message || t('failed'));
    },
    onSuccess: (next) => {
      if (next) queryClient.setQueryData(EXCLUSIONS_KEY, next);
    },
  });

  if (exclusions.isPending) {
    return (
      <div className="space-y-2" aria-busy>
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 rounded-md" />
        ))}
      </div>
    );
  }
  if (exclusions.isError || !exclusions.data) {
    return (
      <ErrorState
        size="sm"
        title={t('loadFailed')}
        description={exclusions.error?.message}
        action={
          <Button variant="outline" size="sm" onClick={() => exclusions.refetch()}>
            {t('tryAgain')}
          </Button>
        }
      />
    );
  }

  const data = exclusions.data;
  const lists = exclusionLists(data, tab, query);
  const addable = tab === 'websites' ? normalizeDomain(query) : null;
  const canAdd = addable && !data.excluded_domains.some((site) => site.domain === addable);
  const set = (input: DesktopCaptureExclusion) => change.mutate(input);
  const kind = tab === 'apps' ? 'app' : 'domain';
  const setBy = t('setByOrg', { org });

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm text-pretty">{t('intro')}</p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Tabs value={tab} onValueChange={(value) => setTab(value as ExclusionTab)}>
          <TabsList aria-label={t('kindLabel')}>
            <TabsTrigger value="apps">{t('apps')}</TabsTrigger>
            <TabsTrigger value="websites">{t('websites')}</TabsTrigger>
          </TabsList>
        </Tabs>
        <InputGroupSearch className="flex-1">
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && canAdd) {
                set({ kind: 'domain', id: addable, on: true });
                setQuery('');
              }
            }}
            placeholder={tab === 'apps' ? t('searchApps') : t('searchWebsites')}
            aria-label={tab === 'apps' ? t('searchApps') : t('searchWebsites')}
          />
        </InputGroupSearch>
      </div>

      {canAdd ? (
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => {
            set({ kind: 'domain', id: addable, on: true });
            setQuery('');
          }}
        >
          <PlusIcon className="size-3.5 shrink-0" />
          {t('addDomain', { domain: addable })}
        </Button>
      ) : null}

      {lists.categories.length > 0 || (tab === 'websites' && !query.trim()) ? (
        <CaptureRowSection title={t('categories')}>
          {lists.categories.map((group) => (
            <ExclusionItem
              key={group.id}
              leading={<Tile icon={GROUP_ICONS[group.id] ?? ShieldCheckIcon} />}
              title={group.name}
              description={
                group.by_org
                  ? setBy
                  : tab === 'apps'
                    ? t('appCount', { count: group.apps })
                    : t('siteCount', { count: group.domains })
              }
              checked={group.enabled}
              locked={group.by_org}
              onChange={(on) => set({ kind: 'group', id: group.id, on })}
            />
          ))}
          {tab === 'websites' && !query.trim() ? (
            <ExclusionItem
              leading={<Tile icon={EyeSlashIcon} />}
              title={t('privateBrowsing')}
              description={data.private_browsing.by_org ? setBy : t('privateBrowsingDescription')}
              checked={data.private_browsing.excluded}
              locked={data.private_browsing.by_org}
              onChange={(on) => set({ kind: 'private-browsing', on })}
            />
          ) : null}
        </CaptureRowSection>
      ) : null}

      <ExclusionList
        title={t('excluded')}
        empty={
          query.trim() ? t('noMatch') : t(tab === 'apps' ? 'noExcludedApps' : 'noExcludedSites')
        }
        rows={lists.excluded}
        tab={tab}
        checked
        setBy={setBy}
        onChange={(row, on) => set({ kind, id: row.id, on })}
      />
      <ExclusionList
        title={t('recent')}
        empty={query.trim() ? t('noMatch') : t(tab === 'apps' ? 'noRecentApps' : 'noRecentSites')}
        rows={lists.recent}
        tab={tab}
        checked={false}
        setBy={setBy}
        onChange={(row, on) => set({ kind, id: row.id, on })}
      />
    </div>
  );
}

function ExclusionList({
  title,
  empty,
  rows,
  tab,
  checked,
  setBy,
  onChange,
}: {
  title: string;
  empty: string;
  rows: ExclusionRow[];
  tab: ExclusionTab;
  checked: boolean;
  setBy: string;
  onChange: (row: ExclusionRow, on: boolean) => void;
}) {
  return (
    <CaptureRowSection title={title}>
      {rows.length === 0 ? (
        <li className="text-muted-foreground py-2.5 text-xs">{empty}</li>
      ) : (
        rows.map((row) => (
          <ExclusionItem
            key={row.id}
            leading={tab === 'apps' ? <AppIcon bundleId={row.id} /> : <Tile icon={GlobeIcon} />}
            title={row.name}
            description={
              row.byOrg ? setBy : tab === 'apps' && row.name !== row.id ? row.id : undefined
            }
            checked={checked}
            locked={row.byOrg}
            onChange={(on) => onChange(row, on)}
          />
        ))
      )}
    </CaptureRowSection>
  );
}

/** One row: leading tile, title, one muted line, the checkbox. Same grammar as `CaptureRow`. */
function ExclusionItem({
  leading,
  title,
  description,
  checked,
  locked,
  onChange,
}: {
  leading: ReactNode;
  title: string;
  description?: ReactNode;
  checked: boolean;
  locked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      {leading}
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="truncate text-sm">{title}</p>
        {description ? (
          <p className="text-muted-foreground truncate text-xs">{description}</p>
        ) : null}
      </div>
      <Checkbox
        checked={checked}
        disabled={locked}
        onCheckedChange={(value) => onChange(value === true)}
        aria-label={title}
      />
    </li>
  );
}

function Tile({ icon: TileIcon }: { icon: Icon }) {
  return (
    <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-sm">
      <TileIcon className="size-4" />
    </span>
  );
}

/** The installed app's own icon, read from this computer; a neutral tile when it is not installed. */
function AppIcon({ bundleId }: { bundleId: string }) {
  const icon = useQuery({
    queryKey: ['desktop-capture-app-icon', bundleId],
    queryFn: () => desktopCaptureAppIcon(bundleId),
    enabled: isDesktop(),
    staleTime: Infinity,
  });
  if (!icon.data) return <Tile icon={AppWindowIcon} />;
  // eslint-disable-next-line @next/next/no-img-element -- a local data URL from the desktop app, not a remote image
  return <img src={icon.data} alt="" className="size-8 shrink-0" />;
}
