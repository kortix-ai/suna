'use client';

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
// action. This file used to hardcode all three — ~150 lines of tables plus an
// implication graph the client invented and the engine did not enforce, so this
// editor could write a role the engine then read differently. Now it renders the
// engine's own data and owns only the words (`AREA_COPY`).
//
// Checking a leaf checks everything it implies; unchecking a leaf unchecks
// everything that implies it, so the matrix can never show a state the engine
// would read differently.

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
import { cn } from '@/lib/utils';
import type { Permission } from '@/lib/iam-client';

// ─── The area table (§7 mapping) ────────────────────────────────────────────

export type CapabilityScope = 'project' | 'account';
export type CellKind = 'view' | 'edit';

export interface AreaDef {
  /** Stable id used by `applyCell`. */
  key: string;
  label: string;
  /** One short line under the label. */
  hint?: string;
  /** Extra note rendered under the row (implication warnings). */
  note?: string;
  view: readonly string[];
  edit: readonly string[];
}

/** Display copy for an area key. The CATALOG owns which leaves are in which
 *  area and what implies what; this owns only the words. An area the server
 *  adds without an entry here renders with a humanized key and no hint, so a
 *  new permission is never invisible. */
const AREA_COPY: Record<string, { label: string; hint?: string; note?: string }> = {
  project: { label: 'Project', hint: 'The project itself — open it, rename it, delete it.' },
  sessions: { label: 'Sessions', hint: 'Read transcripts, start and stop runs.' },
  files: { label: 'Files', hint: 'The project workspace tree.' },
  customize: {
    label: 'Customize',
    hint: 'Agents, skills, connectors, commands, secrets, models, settings.',
  },
  triggers: { label: 'Triggers', hint: 'Schedules and webhooks, and firing them by hand.' },
  git: {
    label: 'Git & Reviews',
    hint: 'Branches, change requests, and the review inbox.',
    note: 'Push access also grants Files, Customize and Triggers edit — a push rewrites those.',
  },
  apps: { label: 'Apps', hint: 'Kortix Apps and what their public hostname serves.' },
  spend: { label: 'Spend & gateway', hint: 'Model spend, request logs, budgets and BYOK keys.' },
  members: { label: 'Members', hint: 'Who has access.' },
  account: { label: 'Account', hint: 'Account name, settings, and deleting the account.' },
  groups: { label: 'Groups', hint: 'Groups and who belongs to them.' },
  roles: { label: 'Roles', hint: 'Custom roles and the assignments that hand them out.' },
  tokens: { label: 'API keys', hint: 'Service-account API keys and personal access keys.' },
  projects: { label: 'Projects', hint: 'Creating a brand-new project in this account.' },
  billing: { label: 'Billing', hint: 'Plan, invoices and payment method.' },
  audit: { label: 'Audit', hint: 'The account audit log.' },
  credentials: { label: 'Credentials', hint: 'Minting long-lived project tokens.' },
};

/** The display name for one catalog area. Exported so the member-capability
 *  panels group by the same words this matrix does. */
export function areaLabel(key: string): string {
  return areaCopy(key).label;
}

/** A readable name for one permission. The catalog's `description` when it has
 *  one, a humanized action string otherwise. */
export function permissionLabel(permission: {
  action: string;
  description?: string;
}): string {
  return permission.description?.trim() || humanizeLeaf(permission.action);
}

function areaCopy(key: string) {
  return (
    AREA_COPY[key] ?? {
      label: key
        .split(/[_.-]/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' '),
    }
  );
}

/** Permissions in one role scope, in catalog order. */
function inScope(
  scope: CapabilityScope,
  permissions: readonly Permission[] | undefined,
): Permission[] {
  return (permissions ?? []).filter((p) => p.scope_type === scope);
}

/**
 * The area table, BUILT FROM THE CATALOG.
 *
 * `area` and `level` are columns on `kortix.permissions`, so the grouping the
 * matrix renders is the grouping the engine ships. This used to be ~150 lines of
 * hardcoded arrays in this file that had to be kept byte-identical to the server
 * by hand — and had already drifted (`project.cr.open`/`project.cr.merge` were
 * still listed here after the server collapsed them into `project.gitops.*`).
 *
 * `admin`-level leaves are placed in NEITHER column. They are the escalation
 * leaves — granting super-admin, minting a credential that outlives the request —
 * and every one of them is `delegable: false` in the catalog. Sweeping them into
 * a cell would hand them out on an "Edit everything" click. They stay individual
 * checkboxes in the Advanced disclosure, which is where a deliberate act belongs.
 */
export function buildAreaTable(
  scope: CapabilityScope,
  permissions: readonly Permission[] | undefined,
): AreaDef[] {
  const order: string[] = [];
  const byArea = new Map<string, { view: string[]; edit: string[] }>();
  for (const entry of inScope(scope, permissions)) {
    let cell = byArea.get(entry.area);
    if (!cell) {
      cell = { view: [], edit: [] };
      byArea.set(entry.area, cell);
      order.push(entry.area);
    }
    if (entry.level === 'view') cell.view.push(entry.action);
    else if (entry.level === 'edit') cell.edit.push(entry.action);
  }
  // An area whose only leaves are `admin` gets no row — its leaves live in
  // Advanced, and an empty row would read as "nothing here".
  return order
    .filter((key) => (byArea.get(key)!.view.length + byArea.get(key)!.edit.length) > 0)
    .map((key) => ({ key, ...areaCopy(key), ...byArea.get(key)! }));
}

/** leaf → leaves it requires, straight off the catalog's `implies`. The client
 *  used to invent this graph (`EXTRA_IMPLICATIONS`) and the engine did not
 *  enforce it; now the engine seeds it and the client renders it. */
export function buildImplications(
  permissions: readonly Permission[] | undefined,
): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, string[]>();
  for (const entry of permissions ?? []) {
    map.set(entry.action, entry.implies.filter((leaf) => leaf !== entry.action));
  }
  return map;
}

function reverse(map: ReadonlyMap<string, readonly string[]>): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const [from, targets] of map) {
    for (const to of targets) {
      const list = out.get(to) ?? [];
      if (!list.includes(from)) list.push(from);
      out.set(to, list);
    }
  }
  return out;
}

/** Transitive closure of `seeds` over `graph`, seeds included. */
function closure(
  graph: ReadonlyMap<string, readonly string[]>,
  seeds: readonly string[],
): Set<string> {
  const out = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const leaf = queue.pop()!;
    if (out.has(leaf)) continue;
    out.add(leaf);
    for (const next of graph.get(leaf) ?? []) if (!out.has(next)) queue.push(next);
  }
  return out;
}

// ─── Pure fold / expand helpers ─────────────────────────────────────────────

export type CellState = 'on' | 'off' | 'partial';

export interface CellFold {
  kind: CellKind;
  /** Leaves this cell owns that actually exist (catalog ∪ current selection). */
  leaves: string[];
  /** The subset of `leaves` currently granted. */
  present: string[];
  state: CellState;
}

export interface AreaFold {
  area: AreaDef;
  view: CellFold;
  edit: CellFold;
  /** True when either cell is a partial subset — the row shows a note. */
  partial: boolean;
}

export interface UnmappedLeaf {
  action: string;
  label: string;
  selected: boolean;
}

export interface CapabilityFold {
  areas: AreaFold[];
  /** Leaves no cell covers, in catalog order, plus any selected stragglers. */
  unmapped: UnmappedLeaf[];
  /** Granted leaves within this scope. */
  selectedCount: number;
  /** Every leaf available in this scope. */
  totalCount: number;
  needsAdvanced: boolean;
}

function humanizeLeaf(action: string): string {
  return action
    .split('.')
    .map((part) => part[0]?.toUpperCase() + part.slice(1).replace(/_/g, ' '))
    .join(' · ');
}

/** Every leaf the area table places in a cell, for one scope. */
function mappedLeaves(areas: readonly AreaDef[]): Set<string> {
  const out = new Set<string>();
  for (const area of areas) {
    for (const leaf of area.view) out.add(leaf);
    for (const leaf of area.edit) out.add(leaf);
  }
  return out;
}

/**
 * Catalog leaves for `scope` that no cell covers. They are never dropped —
 * they render as individual checkboxes in the Advanced disclosure. With the
 * table built from the catalog this is normally empty; it stays because a
 * selection can still carry a leaf the catalog no longer publishes.
 */
export function unmappedLeaves(
  scope: CapabilityScope,
  permissions: readonly Permission[] | undefined,
): string[] {
  const mapped = mappedLeaves(buildAreaTable(scope, permissions));
  return inScope(scope, permissions)
    .filter((p) => !mapped.has(p.action))
    .map((p) => p.action);
}

function cellFold(
  kind: CellKind,
  tableLeaves: readonly string[],
  available: ReadonlySet<string> | null,
  selected: ReadonlySet<string>,
): CellFold {
  const leaves = tableLeaves.filter(
    (leaf) => available === null || available.has(leaf) || selected.has(leaf),
  );
  const present = leaves.filter((leaf) => selected.has(leaf));
  const state: CellState =
    leaves.length === 0 || present.length === 0
      ? 'off'
      : present.length === leaves.length
        ? 'on'
        : 'partial';
  return { kind, leaves, present, state };
}

/**
 * Fold a raw leaf set into per-cell state. `permissions` is the full catalog
 * (any scope) from `listPermissions`; leaves outside `scope` are ignored.
 */
export function foldSelection(
  scope: CapabilityScope,
  permissions: readonly Permission[] | undefined,
  selected: ReadonlySet<string>,
): CapabilityFold {
  const catalog = inScope(scope, permissions);
  const available = catalog.length > 0 ? new Set(catalog.map((a) => a.action)) : null;
  const table = buildAreaTable(scope, permissions);

  const areas: AreaFold[] = table.map((area) => {
    const view = cellFold('view', area.view, available, selected);
    const edit = cellFold('edit', area.edit, available, selected);
    return { area, view, edit, partial: view.state === 'partial' || edit.state === 'partial' };
  });

  const mapped = mappedLeaves(table);
  const seen = new Set<string>();
  const unmapped: UnmappedLeaf[] = [];
  for (const entry of catalog) {
    if (mapped.has(entry.action) || seen.has(entry.action)) continue;
    seen.add(entry.action);
    unmapped.push({
      action: entry.action,
      label: entry.description || humanizeLeaf(entry.action),
      selected: selected.has(entry.action),
    });
  }
  // A granted leaf the catalog no longer lists still has to stay reachable, or
  // saving the role would silently strip it.
  for (const action of selected) {
    if (mapped.has(action) || seen.has(action)) continue;
    if (available !== null && available.has(action)) continue;
    if (resourceScopeOf(action) !== scope) continue;
    seen.add(action);
    unmapped.push({ action, label: humanizeLeaf(action), selected: true });
  }

  const reachable = new Set<string>();
  for (const area of areas) {
    for (const leaf of area.view.leaves) reachable.add(leaf);
    for (const leaf of area.edit.leaves) reachable.add(leaf);
  }
  for (const leaf of unmapped) reachable.add(leaf.action);

  let selectedCount = 0;
  for (const leaf of reachable) if (selected.has(leaf)) selectedCount += 1;

  const needsAdvanced =
    areas.some((a) => a.partial) || unmapped.some((leaf) => leaf.selected);

  return { areas, unmapped, selectedCount, totalCount: reachable.size, needsAdvanced };
}

/**
 * The inverse of `foldSelection`: rebuild the leaf set from the folded state.
 * `foldSelection` → `expandFold` is lossless for any input, which is what
 * keeps a role that predates this table (or one hand-written through the API)
 * safe to open and save.
 */
export function expandFold(fold: CapabilityFold): Set<string> {
  const out = new Set<string>();
  for (const area of fold.areas) {
    for (const leaf of area.view.present) out.add(leaf);
    for (const leaf of area.edit.present) out.add(leaf);
  }
  for (const leaf of fold.unmapped) if (leaf.selected) out.add(leaf.action);
  return out;
}

/** Which role scope a dotted action belongs to. Mirrors the API's
 *  `resourceTypeForAction`, collapsed to the two role scopes. */
function resourceScopeOf(action: string): CapabilityScope {
  if (
    action.startsWith('account.') ||
    action.startsWith('member.') ||
    action.startsWith('group.') ||
    action.startsWith('role.') ||
    action.startsWith('policy.') ||
    action.startsWith('token.') ||
    action.startsWith('billing.') ||
    action.startsWith('audit.') ||
    action === 'project.create'
  ) {
    return 'account';
  }
  return 'project';
}

function addLeaves(
  permissions: readonly Permission[] | undefined,
  selected: ReadonlySet<string>,
  leaves: readonly string[],
  available: ReadonlySet<string> | null,
): Set<string> {
  const next = new Set(selected);
  for (const leaf of closure(buildImplications(permissions), leaves)) {
    if (available && !available.has(leaf) && !selected.has(leaf)) continue;
    next.add(leaf);
  }
  return next;
}

function removeLeaves(
  permissions: readonly Permission[] | undefined,
  selected: ReadonlySet<string>,
  leaves: readonly string[],
): Set<string> {
  const next = new Set(selected);
  for (const leaf of closure(reverse(buildImplications(permissions)), leaves)) next.delete(leaf);
  return next;
}

function availableIn(
  scope: CapabilityScope,
  permissions: readonly Permission[] | undefined,
): ReadonlySet<string> | null {
  const catalog = inScope(scope, permissions);
  return catalog.length > 0 ? new Set(catalog.map((p) => p.action)) : null;
}

/**
 * Toggle one cell. Checking pulls in everything the cell's leaves imply;
 * unchecking drops everything that implies them, so the matrix can never show a
 * granted leaf whose prerequisite is missing.
 *
 * The implication graph is the catalog's `implies` column — the SAME data the
 * engine enforces. It used to be a client-invented graph the engine ignored,
 * which meant this editor could write a role the engine read differently.
 */
export function applyCell(
  scope: CapabilityScope,
  selected: ReadonlySet<string>,
  areaKey: string,
  kind: CellKind,
  checked: boolean,
  permissions: readonly Permission[] | undefined,
): Set<string> {
  const area = buildAreaTable(scope, permissions).find((a) => a.key === areaKey);
  if (!area) return new Set(selected);
  const leaves = kind === 'view' ? area.view : area.edit;
  return checked
    ? addLeaves(permissions, selected, leaves, availableIn(scope, permissions))
    : removeLeaves(permissions, selected, leaves);
}

/** Toggle one raw leaf (the Advanced disclosure). Same implication rules. */
export function applyLeaf(
  scope: CapabilityScope,
  selected: ReadonlySet<string>,
  action: string,
  checked: boolean,
  permissions: readonly Permission[] | undefined,
): Set<string> {
  return checked
    ? addLeaves(permissions, selected, [action], availableIn(scope, permissions))
    : removeLeaves(permissions, selected, [action]);
}

/** "View everything" / "Edit everything" / "Clear". */
export function applyBulk(
  scope: CapabilityScope,
  selected: ReadonlySet<string>,
  action: 'view-all' | 'edit-all' | 'clear',
  permissions: readonly Permission[] | undefined,
): Set<string> {
  const catalog = inScope(scope, permissions);
  const table = buildAreaTable(scope, permissions);
  if (action === 'clear') {
    const next = new Set(selected);
    for (const leaf of mappedLeaves(table)) next.delete(leaf);
    for (const entry of catalog) next.delete(entry.action);
    for (const leaf of selected) if (resourceScopeOf(leaf) === scope) next.delete(leaf);
    return next;
  }
  const leaves: string[] = [];
  for (const area of table) {
    leaves.push(...area.view);
    if (action === 'edit-all') leaves.push(...area.edit);
  }
  return addLeaves(permissions, selected, leaves, availableIn(scope, permissions));
}

// ─── Advanced grouping ──────────────────────────────────────────────────────

export interface LeafGroup {
  label: string;
  entries: { action: string; label: string }[];
}

const GROUP_LABELS: Record<string, string> = {
  gitops: 'Git',
  cr: 'Change requests',
  iam: 'IAM',
};

function groupLabel(segment: string): string {
  if (GROUP_LABELS[segment]) return GROUP_LABELS[segment];
  return segment
    .split(/[_-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Group raw leaves by their capability segment, for the Advanced list. */
export function groupLeaves(entries: { action: string; label: string }[]): LeafGroup[] {
  const byKey = new Map<string, LeafGroup>();
  for (const entry of entries) {
    const segments = entry.action.split('.');
    const key = segments.length >= 3 ? segments[1] : segments[0];
    let group = byKey.get(key);
    if (!group) {
      group = { label: groupLabel(key), entries: [] };
      byKey.set(key, group);
    }
    group.entries.push(entry);
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
}

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
  const [search, setSearch] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const autoOpened = useRef(false);

  const catalog = useMemo(() => inScope(scope, permissions), [permissions, scope]);
  const fold = useMemo(
    () => foldSelection(scope, permissions, selected),
    [scope, permissions, selected],
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
    if (!query) return fold.areas;
    return fold.areas.filter(
      (row) =>
        row.area.label.toLowerCase().includes(query) ||
        row.area.hint?.toLowerCase().includes(query) ||
        row.view.leaves.some((leaf) => leaf.includes(query)) ||
        row.edit.leaves.some((leaf) => leaf.includes(query)),
    );
  }, [fold.areas, query]);

  const advancedGroups = useMemo(() => {
    const entries = [
      ...catalog.map((a) => ({ action: a.action, label: a.description || humanizeLeaf(a.action) })),
      ...fold.unmapped
        .filter((leaf) => !catalog.some((a) => a.action === leaf.action))
        .map((leaf) => ({ action: leaf.action, label: leaf.label })),
    ].filter((entry) => !query || entry.action.includes(query) || entry.label.toLowerCase().includes(query));
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
        <Label>Capabilities</Label>
        <div className="bg-popover rounded-md border px-4 py-3">
          <p className="text-muted-foreground text-xs">
            No capabilities are available for this scope.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="role-capability-search">Capabilities</Label>
        <span className="text-muted-foreground text-xs tabular-nums">
          {fold.selectedCount} of {fold.totalCount} capabilities
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
            placeholder="Search areas…"
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
          View everything
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground h-8 px-2 text-xs"
          disabled={disabled}
          onClick={() => onChange(applyBulk(scope, selected, 'edit-all', permissions))}
        >
          Edit everything
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground h-8 px-2 text-xs"
          disabled={disabled}
          onClick={() => onChange(applyBulk(scope, selected, 'clear', permissions))}
        >
          Clear
        </Button>
      </div>

      <div className="bg-popover divide-border divide-y rounded-md border">
        <div className="text-muted-foreground flex items-center gap-3 px-4 py-2 text-xs">
          <span className="min-w-0 flex-1">Area</span>
          <span className="w-10 shrink-0 text-center">View</span>
          <span className="w-10 shrink-0 text-center">Edit</span>
        </div>

        {rows.length === 0 ? (
          <p className="text-muted-foreground px-3 py-6 text-center text-xs">
            No areas match your search.
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
                    Custom subset — the exact capabilities are in Advanced.
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
            <span className="text-sm font-medium">Advanced</span>
            <span className="text-muted-foreground text-xs">
              {advancedOpen ? 'Hide' : 'Every capability, one by one'}
            </span>
          </Button>
        </DisclosureTrigger>
        <DisclosureContent variant="outline" contentClassName="border-border border-t">
          <div className="max-h-72 space-y-4 overflow-y-auto px-4 py-3">
            {advancedGroups.length === 0 ? (
              <p className="text-muted-foreground px-3 py-6 text-center text-xs">
                No capabilities match your search.
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
