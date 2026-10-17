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
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTranslations } from '@/i18n/use-translations';

import {
  exclusionLists,
  type ExclusionChange,
  type ExclusionRow,
  type ExclusionTab,
  type ExclusionsView,
  type IncludedView,
} from './exclusions-model';

const GROUP_ICONS: Record<string, Icon> = {
  password_managers: KeyIcon,
  messaging: ChatCircleIcon,
  banking: BankIcon,
};

/**
 * The organization's Exclusions (account settings ▸ Kortix Capture): Apps |
 * Websites, the categories, private browsing and what is excluded. The
 * mandatory lists every device applies; apps and websites are added by id from
 * the search box. Each row is one checkbox.
 */
export function ExclusionsEditor({
  view,
  org,
  onChange,
}: {
  view: ExclusionsView;
  org: string;
  onChange: (change: ExclusionChange) => void;
}) {
  const t = useTranslations('capture.settings.exclusions');
  const tGroup = useTranslations('capture.settings.exclusions.group');
  const [tab, setTab] = useState<ExclusionTab>('apps');
  const [query, setQuery] = useState('');
  const lists = exclusionLists(view, tab, query);
  const apps = tab === 'apps';
  const kind = apps ? 'app' : 'domain';
  const addable = apps ? normalizeCaptureAppId(query) : normalizeCaptureDomain(query);
  const canAdd = addable && !(apps ? view.apps : view.domains).some((row) => row.id === addable);
  const add = () => {
    if (!canAdd) return;
    onChange({ kind, id: addable, on: true });
    setQuery('');
  };
  const setBy = t('setByOrg', { org });
  const known = (id: string): id is CaptureExclusionGroup =>
    (CAPTURE_EXCLUSION_GROUPS as readonly string[]).includes(id);
  const searchLabel = apps ? t('searchOrAddApp') : t('searchWebsites');

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-xs text-pretty">{t('orgIntro', { org })}</p>
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
        <RowSection title={t('categories')}>
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
        </RowSection>
      ) : null}

      <ExclusionList
        title={t('excluded')}
        empty={query.trim() ? t('noMatch') : t(apps ? 'noExcludedApps' : 'noExcludedSites')}
        rows={lists.excluded}
        apps={apps}
        setBy={setBy}
        onChange={(row, on) => onChange({ kind, id: row.id, on })}
      />
    </div>
  );
}

/** A titled section of flat rows. */
function RowSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1">
      <div className="flex min-h-8 items-center">
        <Label>{title}</Label>
      </div>
      <ul className="divide-border divide-y">{children}</ul>
    </section>
  );
}

/** What is excluded: every row checked; unchecking one removes it. */
function ExclusionList({
  title,
  empty,
  rows,
  apps,
  setBy,
  onChange,
}: {
  title: string;
  empty: string;
  rows: ExclusionRow[];
  apps: boolean;
  setBy: string;
  onChange: (row: ExclusionRow, on: boolean) => void;
}) {
  return (
    <RowSection title={title}>
      {rows.length === 0 ? (
        <li className="text-muted-foreground py-2.5 text-xs">{empty}</li>
      ) : (
        rows.map((row) => (
          <ExclusionItem
            key={row.id}
            leading={<Tile icon={apps ? AppWindowIcon : GlobeIcon} />}
            title={row.name}
            description={row.locked ? setBy : apps && row.name !== row.id ? row.id : undefined}
            checked
            locked={row.locked}
            onChange={(on) => onChange(row, on)}
          />
        ))
      )}
    </RowSection>
  );
}

/** One row: leading tile, title, one muted line, the checkbox. */
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

/**
 * Record only included (account settings ▸ Kortix Capture): Apps | Websites the
 * organization includes. An included app is recorded in full; an included website
 * in any browser. Everything else is blacked out. People can add their own.
 */
export function IncludedEditor({
  view,
  onChange,
}: {
  view: IncludedView;
  onChange: (change: ExclusionChange) => void;
}) {
  const t = useTranslations('capture.settings.included');
  const [tab, setTab] = useState<ExclusionTab>('apps');
  const [query, setQuery] = useState('');
  const apps = tab === 'apps';
  const list = apps ? view.apps : view.domains;
  const addable = apps ? normalizeCaptureAppId(query) : normalizeCaptureDomain(query);
  const canAdd = addable && !list.some((row) => row.id === addable);
  const add = () => {
    if (!canAdd) return;
    onChange({ kind: apps ? 'include-app' : 'include-domain', id: addable, on: true });
    setQuery('');
  };
  const placeholder = apps ? t('addAppPlaceholder') : t('addSitePlaceholder');
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Tabs value={tab} onValueChange={(value) => setTab(value as ExclusionTab)}>
          <TabsList aria-label={t('kindLabel')}>
            <TabsTrigger value="apps">{t('apps')}</TabsTrigger>
            <TabsTrigger value="websites">{t('websites')}</TabsTrigger>
          </TabsList>
        </Tabs>
        <InputGroupSearch className="flex-1">
          <InputGroupSearchIcon>
            <PlusIcon />
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
            placeholder={placeholder}
            aria-label={placeholder}
          />
        </InputGroupSearch>
      </div>
      {canAdd ? (
        <Button variant="outline" size="sm" className="gap-1.5" onClick={add}>
          <PlusIcon className="size-3.5 shrink-0" />
          {apps ? t('addApp', { app: addable }) : t('addDomain', { domain: addable })}
        </Button>
      ) : null}
      <ExclusionList
        title={t('included')}
        empty={t(apps ? 'noApps' : 'noSites')}
        rows={list}
        apps={apps}
        setBy=""
        onChange={(row, on) =>
          onChange({ kind: apps ? 'include-app' : 'include-domain', id: row.id, on })
        }
      />
    </div>
  );
}
