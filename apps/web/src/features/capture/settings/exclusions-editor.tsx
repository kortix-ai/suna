'use client';

import {
  CAPTURE_EXCLUSION_GROUPS,
  normalizeCaptureAppId,
  normalizeCaptureDomain,
  type CaptureExclusionGroup,
} from '@kortix/sdk';
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
import { useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  InputGroupSearch,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTranslations } from '@/i18n/use-translations';

import { CaptureRowSection } from '../desktop/capture-rows';
import {
  exclusionLists,
  type ExclusionChange,
  type ExclusionRow,
  type ExclusionTab,
  type ExclusionsView,
} from './exclusions-model';

const GROUP_ICONS: Record<string, Icon> = {
  password_managers: KeyIcon,
  messaging: ChatCircleIcon,
  banking: BankIcon,
};

/**
 * Every Exclusions screen of Kortix Capture: Apps | Websites, the categories,
 * private browsing, what is excluded and (on a device) what was recorded
 * lately. Each row is one checkbox; a row the organization set is locked.
 *
 * - `org`: Organization settings. The mandatory lists every device applies.
 *   Apps and websites are added by id from the search box.
 * - `device`: This computer, in the desktop app. The person's own exclusions,
 *   kept on this computer only, with the organization's locked.
 */
export function ExclusionsEditor({
  mode,
  view,
  org,
  onChange,
  appIcon,
}: {
  mode: 'org' | 'device';
  view: ExclusionsView;
  org: string;
  onChange: (change: ExclusionChange) => void;
  appIcon?: (bundleId: string) => ReactNode;
}) {
  const t = useTranslations('capture.dialog.exclusions');
  const tGroup = useTranslations('capture.settings.exclusions.group');
  const [tab, setTab] = useState<ExclusionTab>('apps');
  const [query, setQuery] = useState('');
  const lists = exclusionLists(view, tab, query);
  const apps = tab === 'apps';
  const kind = apps ? 'app' : 'domain';
  const addable = apps
    ? mode === 'org'
      ? normalizeCaptureAppId(query)
      : null
    : normalizeCaptureDomain(query);
  const canAdd = addable && !(apps ? view.apps : view.domains).some((row) => row.id === addable);
  const add = () => {
    if (!canAdd) return;
    onChange({ kind, id: addable, on: true });
    setQuery('');
  };
  const setBy = t('setByOrg', { org });
  const known = (id: string): id is CaptureExclusionGroup =>
    (CAPTURE_EXCLUSION_GROUPS as readonly string[]).includes(id);
  const searchLabel = apps
    ? mode === 'org'
      ? t('searchOrAddApp')
      : t('searchApps')
    : t('searchWebsites');

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-xs text-pretty">
        {mode === 'org' ? t('orgIntro', { org }) : t('intro')}
      </p>
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
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              add();
            }}
            placeholder={searchLabel}
            aria-label={searchLabel}
          />
        </InputGroupSearch>
      </div>

      {canAdd ? (
        <Button variant="outline" size="sm" className="gap-1.5" onClick={add}>
          <PlusIcon className="size-3.5 shrink-0" />
          {apps ? t('addApp', { app: addable }) : t('addDomain', { domain: addable })}
        </Button>
      ) : null}

      {lists.categories.length > 0 || (!apps && !query.trim()) ? (
        <CaptureRowSection title={t('categories')}>
          {lists.categories.map((group) => {
            const count = apps ? group.apps : group.domains;
            return (
              <ExclusionItem
                key={group.id}
                leading={<Tile icon={GROUP_ICONS[group.id] ?? ShieldCheckIcon} />}
                title={known(group.id) ? tGroup(group.id) : group.name}
                description={
                  group.locked
                    ? setBy
                    : count === null
                      ? known(group.id)
                        ? tGroup(`${group.id}Hint`)
                        : group.description
                      : apps
                        ? t('appCount', { count })
                        : t('siteCount', { count })
                }
                checked={group.enabled}
                locked={group.locked}
                onChange={(on) => onChange({ kind: 'group', id: group.id, on })}
              />
            );
          })}
          {!apps && !query.trim() ? (
            <ExclusionItem
              leading={<Tile icon={EyeSlashIcon} />}
              title={t('privateBrowsing')}
              description={view.privateBrowsing.locked ? setBy : t('privateBrowsingDescription')}
              checked={view.privateBrowsing.excluded}
              locked={view.privateBrowsing.locked}
              onChange={(on) => onChange({ kind: 'private-browsing', on })}
            />
          ) : null}
        </CaptureRowSection>
      ) : null}

      <ExclusionList
        title={t('excluded')}
        empty={query.trim() ? t('noMatch') : t(apps ? 'noExcludedApps' : 'noExcludedSites')}
        rows={lists.excluded}
        apps={apps}
        checked
        setBy={setBy}
        appIcon={appIcon}
        onChange={(row, on) => onChange({ kind, id: row.id, on })}
      />
      {mode === 'device' ? (
        <ExclusionList
          title={t('recent')}
          empty={query.trim() ? t('noMatch') : t(apps ? 'noRecentApps' : 'noRecentSites')}
          rows={lists.recent}
          apps={apps}
          checked={false}
          setBy={setBy}
          appIcon={appIcon}
          onChange={(row, on) => onChange({ kind, id: row.id, on })}
        />
      ) : null}
    </div>
  );
}

function ExclusionList({
  title,
  empty,
  rows,
  apps,
  checked,
  setBy,
  appIcon,
  onChange,
}: {
  title: string;
  empty: string;
  rows: ExclusionRow[];
  apps: boolean;
  checked: boolean;
  setBy: string;
  appIcon?: (bundleId: string) => ReactNode;
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
            leading={
              apps ? (
                (appIcon?.(row.id) ?? <Tile icon={AppWindowIcon} />)
              ) : (
                <Tile icon={GlobeIcon} />
              )
            }
            title={row.name}
            description={row.locked ? setBy : apps && row.name !== row.id ? row.id : undefined}
            checked={checked}
            locked={row.locked}
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
