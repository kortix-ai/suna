'use client';

import { APP_REGISTRY_TRANSLATION_KEYS } from '@/i18n/app-registry-translation-keys.generated';
import { localizeUiCatalog } from '@/i18n/localize-ui-catalog';
import { useTranslations } from '@/i18n/use-translations';
// The capability picker for a custom role (§7 of the access unification spec).
//
// A role's permission set is a list of ~44 dotted leaf actions. Showing 44
// checkboxes made "what can this role do?" unanswerable at a glance, so this
// component shows AREAS with two checkboxes each — View and Edit — and expands
// a cell back to its leaf actions on save. The wire format is unchanged:
// `createRole` / `updateRolePermissions` still receive the same leaf strings,
// and the IAM engine is untouched. This is display-side only.
//
// Nothing is ever dropped. A leaf that no cell covers (tokens' super-admin
// grant, anything added to the API after this table) and a cell whose leaves
// are only partially present both stay editable in the "Advanced" disclosure,
// which auto-opens when the loaded role needs it.
//
// The AREAS, the View/Edit split and the IMPLICATIONS all come from the server:
// `GET /accounts/:id/iam/permissions` returns `area`, `level` and `implies` per
// action. The pure model that builds the table, folds the selection and applies
// the toggles lives in `./role-capability-model` — this file is the renderer,
// and the member panels read the shared labels from the model too, not from
// here.

import { MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import type { Permission } from '@/lib/iam-client';
import { cn } from '@/lib/utils';
import {
  applyBulk,
  applyCell,
  applyLeaf,
  foldSelection,
  groupLeaves,
  humanizeLeaf,
  type CapabilityScope,
  type CellFold,
  type CellKind,
} from './role-capability-model';

// The model's public names stay importable from this renderer path — every
// existing importer (tests, member panels) keeps working through the re-export.
export * from './role-capability-model';

// ─── Component ──────────────────────────────────────────────────────────────

const MATRIX_NOTE =
  'One vocabulary for people and agents: a role picks areas a person can view or edit; the ' +
  "agent's kortix.yaml scopes pick from the same list. At runtime a session can only do what " +
  'BOTH allow.';

export interface RoleCapabilityMatrixProps {
  scope: CapabilityScope;
  /** The permission catalog from `listPermissions`. It carries `area`, `level`
   *  and `implies`, so the areas, the columns and the implication rules this
   *  editor enforces are all the server's, not this file's. */
  permissions: readonly Permission[] | undefined;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
}

export function RoleCapabilityMatrix({
  scope,
  permissions,
  selected,
  onChange,
  disabled = false,
}: RoleCapabilityMatrixProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [search, setSearch] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const autoOpened = useRef(false);

  const catalog = useMemo(
    () => (permissions ?? []).filter((p) => p.scope_type === scope),
    [permissions, scope],
  );
  const fold = useMemo(
    () => foldSelection(scope, permissions, selected),
    [scope, permissions, selected],
  );
  const localizedAreas = useMemo(
    () => localizeUiCatalog(fold.areas, tI18nComplete, APP_REGISTRY_TRANSLATION_KEYS),
    [fold.areas, tI18nComplete],
  );

  // Open Advanced by itself the first time a role arrives with a partial cell
  // or an unmapped grant — otherwise those leaves would be invisible.
  useEffect(() => {
    if (fold.needsAdvanced && !autoOpened.current) {
      autoOpened.current = true;
      setAdvancedOpen(true);
    }
  }, [fold.needsAdvanced]);

  const query = search.trim().toLowerCase();
  const rows = useMemo(() => {
    if (!query) return localizedAreas;
    return localizedAreas.filter(
      (row) =>
        row.area.label.toLowerCase().includes(query) ||
        row.area.hint?.toLowerCase().includes(query) ||
        row.view.leaves.some((leaf) => leaf.includes(query)) ||
        row.edit.leaves.some((leaf) => leaf.includes(query)),
    );
  }, [localizedAreas, query]);

  const advancedGroups = useMemo(() => {
    const entries = [
      ...catalog.map((a) => ({ action: a.action, label: a.description || humanizeLeaf(a.action) })),
      ...fold.unmapped
        .filter((leaf) => !catalog.some((a) => a.action === leaf.action))
        .map((leaf) => ({ action: leaf.action, label: leaf.label })),
    ].filter(
      (entry) =>
        !query || entry.action.includes(query) || entry.label.toLowerCase().includes(query),
    );
    return groupLeaves(entries);
  }, [catalog, fold.unmapped, query]);

  function setCell(areaKey: string, kind: CellKind, checked: boolean) {
    onChange(applyCell(scope, selected, areaKey, kind, checked, permissions));
  }

  function setLeaf(action: string, checked: boolean) {
    onChange(applyLeaf(scope, selected, action, checked, permissions));
  }

  if (catalog.length === 0 && (permissions?.length ?? 0) > 0) {
    return (
      <div className="space-y-2">
        <Label>{tI18nComplete.raw('text9460f16ac9b5')}</Label>
        <div className="bg-popover rounded-md border px-4 py-3">
          <p className="text-muted-foreground text-xs">{tI18nComplete.raw('text3608d632c70d')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="role-capability-search">{tI18nComplete.raw('text9460f16ac9b5')}</Label>
        <span className="text-muted-foreground text-xs tabular-nums">
          {fold.selectedCount} {tI18nComplete.raw('text28391d3bc64e')} {fold.totalCount}{' '}
          {tI18nComplete.raw('text3fc0e5c4c484')}
        </span>
      </div>

      <p className="text-muted-foreground text-xs">{MATRIX_NOTE}</p>

      <div className="flex flex-wrap items-center gap-1.5">
        <InputGroupSearch className="min-w-40 flex-1">
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            id="role-capability-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={tI18nComplete.raw('texta3fc7afcc66e')}
            variant="popover"
          />
          {search ? <InputGroupSearchClear onClick={() => setSearch('')} /> : null}
        </InputGroupSearch>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground h-8 px-2 text-xs"
          disabled={disabled}
          onClick={() => onChange(applyBulk(scope, selected, 'view-all', permissions))}
        >
          {tI18nComplete.raw('text905a97d81301')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground h-8 px-2 text-xs"
          disabled={disabled}
          onClick={() => onChange(applyBulk(scope, selected, 'edit-all', permissions))}
        >
          {tI18nComplete.raw('textd1dc8f6ab64a')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground h-8 px-2 text-xs"
          disabled={disabled}
          onClick={() => onChange(applyBulk(scope, selected, 'clear', permissions))}
        >
          {tI18nComplete.raw('text83b12c2216ef')}
        </Button>
      </div>

      <div className="bg-popover divide-border divide-y rounded-md border">
        <div className="text-muted-foreground flex items-center gap-3 px-4 py-2 text-xs">
          <span className="min-w-0 flex-1">{tI18nComplete.raw('text024dc204d7ba')}</span>
          <span className="w-10 shrink-0 text-center">{tI18nComplete.raw('textdcc839a4015c')}</span>
          <span className="w-10 shrink-0 text-center">{tI18nComplete.raw('text464c4ffd019e')}</span>
        </div>

        {rows.length === 0 ? (
          <p className="text-muted-foreground px-3 py-6 text-center text-xs">
            {tI18nComplete.raw('textcd8ddd0a6ec6')}
          </p>
        ) : (
          rows.map((row) => (
            <div key={row.area.key} className="flex items-start gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="text-foreground text-sm font-medium">{row.area.label}</p>
                {row.area.hint ? (
                  <p className="text-muted-foreground text-xs">{row.area.hint}</p>
                ) : null}
                {row.area.note ? (
                  <p className="text-muted-foreground/80 text-xs">{row.area.note}</p>
                ) : null}
                {row.partial ? (
                  <p className="text-muted-foreground text-xs">
                    {tI18nComplete.raw('text19a79f3e7ac6')}
                  </p>
                ) : null}
              </div>
              <MatrixCell
                areaLabel={row.area.label}
                cell={row.view}
                kind="view"
                disabled={disabled}
                onToggle={(checked) => setCell(row.area.key, 'view', checked)}
              />
              <MatrixCell
                areaLabel={row.area.label}
                cell={row.edit}
                kind="edit"
                disabled={disabled}
                onToggle={(checked) => setCell(row.area.key, 'edit', checked)}
              />
            </div>
          ))
        )}
      </div>

      <Disclosure variant="outline" open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <DisclosureTrigger variant="outline">
          <Button
            type="button"
            variant="popover"
            className="flex w-full items-center justify-between rounded-none"
          >
            <span className="text-sm font-medium">{tI18nComplete.raw('text9f088dbebd6c')}</span>
            <span className="text-muted-foreground text-xs">
              {advancedOpen ? 'Hide' : tI18nComplete.raw('textee2682510c82')}
            </span>
          </Button>
        </DisclosureTrigger>
        <DisclosureContent variant="outline" contentClassName="border-border border-t">
          <div className="max-h-72 space-y-4 overflow-y-auto px-4 py-3">
            {advancedGroups.length === 0 ? (
              <p className="text-muted-foreground px-3 py-6 text-center text-xs">
                {tI18nComplete.raw('textdd422a57c3ed')}
              </p>
            ) : (
              advancedGroups.map((group) => (
                <div key={group.label} className="space-y-1.5">
                  <div className="text-muted-foreground text-xs font-medium">{group.label}</div>
                  <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
                    {group.entries.map((entry) => (
                      <label
                        key={entry.action}
                        className={cn(
                          'text-foreground flex cursor-pointer items-center gap-2 text-sm',
                          disabled && 'pointer-events-none opacity-60',
                        )}
                      >
                        <Checkbox
                          checked={selected.has(entry.action)}
                          onCheckedChange={(c) => setLeaf(entry.action, c === true)}
                          disabled={disabled}
                          aria-label={entry.action}
                        />
                        <span className="truncate" title={entry.action}>
                          {entry.label}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </DisclosureContent>
      </Disclosure>
    </div>
  );
}

function MatrixCell({
  areaLabel,
  cell,
  kind,
  disabled,
  onToggle,
}: {
  areaLabel: string;
  cell: CellFold;
  kind: CellKind;
  disabled: boolean;
  onToggle: (checked: boolean) => void;
}) {
  if (cell.leaves.length === 0) {
    return (
      <span
        className="text-muted-foreground/50 flex w-10 shrink-0 justify-center pt-0.5 text-sm"
        aria-hidden
      >
        —
      </span>
    );
  }
  return (
    <span className="flex w-10 shrink-0 justify-center pt-0.5">
      <Checkbox
        checked={cell.state === 'partial' ? 'indeterminate' : cell.state === 'on'}
        onCheckedChange={(c) => onToggle(c === true)}
        disabled={disabled}
        aria-label={`${kind === 'view' ? 'View' : 'Edit'} ${areaLabel}`}
        className={cn(
          'relative',
          'data-[state=indeterminate]:border-foreground/60',
          'data-[state=indeterminate]:[&_svg]:hidden',
          'data-[state=indeterminate]:after:bg-foreground data-[state=indeterminate]:after:absolute',
          'data-[state=indeterminate]:after:inset-x-[3px] data-[state=indeterminate]:after:h-0.5',
          'data-[state=indeterminate]:after:rounded-full data-[state=indeterminate]:after:content-[""]',
        )}
      />
    </span>
  );
}
