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

import { Button } from '@kortix/ui/button';
import { Checkbox } from '@kortix/ui/checkbox';
import {
  InputGroupSearch,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@kortix/ui/input-group';
import { Label } from '@kortix/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@kortix/ui/tabs';
import { useTranslations } from '@/i18n/use-translations';

import {
  catalogApp,
  catalogSuggestions,
  namedAppRows,
  siteSuggestions,
} from './capture-app-catalog';
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
            const summary =
              count === null ? '' : apps ? t('appCount', { count }) : t('siteCount', { count });
            return (
              <CategoryItem
                key={group.id}
                icon={GROUP_ICONS[group.id] ?? ShieldCheckIcon}
                title={known(group.id) ? tGroup(group.id) : group.name}
                description={[group.locked ? setBy : '', summary].filter(Boolean).join(' · ')}
                members={apps ? memberApps(group.members.apps) : group.members.domains}
                showLabel={t('showList')}
                hideLabel={t('hideList')}
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

      <QuickAdd
        label={t(apps ? 'commonApps' : 'commonSites')}
        items={
          apps
            ? catalogSuggestions(
                view.apps.map((r) => r.id),
                query,
              ).map((a) => ({ key: a.name, name: a.name, ids: a.ids }))
            : siteSuggestions(
                view.domains.map((r) => r.id),
                query,
              ).map((d) => ({ key: d, name: d, ids: [d] }))
        }
        onAdd={(ids) => {
          ids.forEach((id) => onChange({ kind, id, on: true }));
          setQuery('');
        }}
      />

      <ExclusionList
        title={t('excluded')}
        empty={query.trim() ? t('noMatch') : t(apps ? 'noExcludedApps' : 'noExcludedSites')}
        rows={lists.excluded}
        apps={apps}
        setBy={setBy}
        onChange={(id, on) => onChange({ kind, id, on })}
      />
    </div>
  );
}

/** A category's apps by name (one name per app, its macOS and Windows ids together). */
function memberApps(ids: string[]): string[] {
  const names = ids.map((id) => catalogApp(id)?.name ?? id);
  return [...new Set(names)];
}

/** A category row whose list opens below it: exactly what the category covers. */
function CategoryItem({
  icon,
  title,
  description,
  members,
  showLabel,
  hideLabel,
  checked,
  locked,
  onChange,
}: {
  icon: Icon;
  title: string;
  description: string;
  members: string[];
  showLabel: string;
  hideLabel: string;
  checked: boolean;
  locked: boolean;
  onChange: (on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ExclusionItem
        leading={<Tile icon={icon} />}
        title={title}
        description={
          <span className="flex items-center gap-1.5">
            {description}
            {members.length > 0 ? (
              <button
                type="button"
                className="text-foreground underline-offset-2 hover:underline"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
              >
                {open ? hideLabel : showLabel}
              </button>
            ) : null}
          </span>
        }
        checked={checked}
        locked={locked}
        onChange={onChange}
      />
      {open ? (
        <li className="pb-2.5 pl-11">
          <p className="text-muted-foreground max-h-40 overflow-y-auto text-xs leading-relaxed">
            {members.join(', ')}
          </p>
        </li>
      ) : null}
    </>
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

/** A list: every row checked; unchecking one removes it. Apps show by name, one row per app. */
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
  onChange: (id: string, on: boolean) => void;
}) {
  const shown = apps
    ? namedAppRows(rows)
    : rows.map((row) => ({ ids: [row.id], name: row.name, detail: '', locked: row.locked }));
  return (
    <RowSection title={title}>
      {shown.length === 0 ? (
        <li className="text-muted-foreground py-2.5 text-xs">{empty}</li>
      ) : (
        shown.map((row) => (
          <ExclusionItem
            key={row.ids.join(' ')}
            leading={<Tile icon={apps ? AppWindowIcon : GlobeIcon} />}
            title={row.name}
            description={row.locked && setBy ? setBy : row.detail || undefined}
            checked
            locked={row.locked}
            onChange={(on) => row.ids.forEach((id) => onChange(id, on))}
          />
        ))
      )}
    </RowSection>
  );
}

/** Common apps or websites not in the list yet, one click each. */
function QuickAdd({
  label,
  items,
  onAdd,
}: {
  label: string;
  items: { key: string; name: string; ids: string[] }[];
  onAdd: (ids: string[]) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-1.5">
        {items.slice(0, 12).map((item) => (
          <Button
            key={item.key}
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={() => onAdd(item.ids)}
          >
            <PlusIcon className="size-3 shrink-0" />
            {item.name}
          </Button>
        ))}
      </div>
    </div>
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
      <QuickAdd
        label={t(apps ? 'commonApps' : 'commonSites')}
        items={
          apps
            ? catalogSuggestions(
                view.apps.map((r) => r.id),
                query,
              ).map((a) => ({ key: a.name, name: a.name, ids: a.ids }))
            : siteSuggestions(
                view.domains.map((r) => r.id),
                query,
              ).map((d) => ({ key: d, name: d, ids: [d] }))
        }
        onAdd={(ids) => {
          ids.forEach((id) =>
            onChange({ kind: apps ? 'include-app' : 'include-domain', id, on: true }),
          );
          setQuery('');
        }}
      />
      <ExclusionList
        title={t('included')}
        empty={t(apps ? 'noApps' : 'noSites')}
        rows={list}
        apps={apps}
        setBy=""
        onChange={(id, on) => onChange({ kind: apps ? 'include-app' : 'include-domain', id, on })}
      />
    </div>
  );
}
