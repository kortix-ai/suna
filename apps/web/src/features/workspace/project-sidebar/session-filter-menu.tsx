'use client';

import type { ComponentType } from 'react';

import {
  matchesSourceFilters,
  matchesStatusFilters,
  SESSION_SOURCE_FILTERS,
  SESSION_STATUS_FILTERS,
  type SessionSourceFilter,
  type SessionStatusFilter,
} from '@/components/projects/session-label';
import {
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/features/icon/icon';
import { useSessionFilterStore } from '@/stores/session-filter-store';
import type { ProjectSession } from '@kortix/sdk';
import {
  CalendarDotsIcon as CalendarClock,
  EnvelopeIcon as Mail,
  ChatsIcon as MessagesSquare,
  UsersIcon as UsersSolid,
  WebhooksLogoIcon as Webhook,
} from '@phosphor-icons/react';

import {
  groupSessions,
  SESSION_GROUP_MODES,
  SESSION_ORDER_MODES,
  type SessionGroupMode,
  type SessionOrderMode,
} from './session-grouping';

/**
 * The Cursor-style nested `⋯` menu behind the sidebar's Sessions header and
 * (from the next phase) every section header. Renders only
 * `DropdownMenuContent` — the caller supplies `DropdownMenu` +
 * `DropdownMenuTrigger` — so one menu definition can hang off two different
 * triggers with no duplicated state.
 *
 * All the counting/section-listing logic below is pure and exported
 * separately from the component so the faceted-count invariant — a count
 * must equal the number of rows that render when that option is picked — has
 * something testable to pin it down. An earlier phase shipped two count bugs
 * in exactly this area because the logic lived only in JSX.
 */

export interface SessionFilterFacetOption<V extends string> {
  value: V;
  label: string;
  count: number;
}

export interface SessionFilterShowOption {
  id: string;
  label: string;
}

/**
 * Section ids the CURRENT grouping mode would offer, ignoring hidden-section
 * state — `Show` has to be able to list a section the user already hid, so it
 * can be turned back on.
 *
 * `reviewCountBySession` is empty: this component only receives `sessions`,
 * not the review-center summary, so in `status` mode the `needs-you` section
 * is only listed when at least one session's raw status would otherwise land
 * it in a different bucket... in practice this means `needs-you` never shows
 * a checkbox from this call alone. That is an accepted gap of the declared
 * `<SessionFilterMenu projectId sessions align? />` surface, not a bug: the
 * component was not handed review data to be more precise with.
 */
export function resolveShowOptions(
  sessions: ProjectSession[],
  mode: SessionGroupMode,
): SessionFilterShowOption[] {
  return groupSessions(sessions, {
    mode,
    order: 'activity',
    reviewCountBySession: {},
  }).sections.map((section) => ({ id: section.id, label: section.label }));
}

/** The section ids that would actually render right now — mode, order, and
 *  hidden state all applied. What `Collapse all` collapses. */
export function resolveRenderedSectionIds(
  sessions: ProjectSession[],
  mode: SessionGroupMode,
  order: SessionOrderMode,
  hiddenSections: readonly string[],
): string[] {
  return groupSessions(sessions, {
    mode,
    order,
    reviewCountBySession: {},
    hiddenSections,
  }).sections.map((section) => section.id);
}

/**
 * Faceted checkbox options for one filter dimension.
 *
 * `facetedSessions` is already narrowed to the sessions that pass the OTHER
 * dimension's active filter — the caller does that narrowing, because which
 * dimension is "the other one" differs between Status and Source. Each
 * option's own count then comes from matching that option ALONE, which is
 * exactly the row count the list would show if the user picked only this
 * option in this facet: the invariant this whole module exists to hold.
 *
 * An option is listed when it has a nonzero count, or is already selected —
 * a selected option can legitimately count 0 (e.g. Source=Slack, Status=
 * Running, no Slack session running) and must stay reachable to deselect.
 */
function buildFacetOptions<V extends string>(
  declared: ReadonlyArray<{ value: V; label: string }>,
  facetedSessions: ProjectSession[],
  matchesOne: (session: ProjectSession, value: V) => boolean,
  active: readonly V[],
): SessionFilterFacetOption<V>[] {
  return declared
    .map((option) => ({
      ...option,
      count: facetedSessions.filter((session) => matchesOne(session, option.value)).length,
    }))
    .filter((option) => option.count > 0 || active.includes(option.value));
}

export function resolveStatusFacetOptions(
  sessions: ProjectSession[],
  statusFilters: readonly SessionStatusFilter[],
  sourceFilters: readonly SessionSourceFilter[],
): SessionFilterFacetOption<SessionStatusFilter>[] {
  const passingSource = sessions.filter((session) => matchesSourceFilters(session, sourceFilters));
  return buildFacetOptions(
    SESSION_STATUS_FILTERS,
    passingSource,
    (session, value) => matchesStatusFilters(session, [value]),
    statusFilters,
  );
}

export function resolveSourceFacetOptions(
  sessions: ProjectSession[],
  statusFilters: readonly SessionStatusFilter[],
  sourceFilters: readonly SessionSourceFilter[],
): SessionFilterFacetOption<SessionSourceFilter>[] {
  const passingStatus = sessions.filter((session) => matchesStatusFilters(session, statusFilters));
  return buildFacetOptions(
    SESSION_SOURCE_FILTERS,
    passingStatus,
    (session, value) => matchesSourceFilters(session, [value]),
    sourceFilters,
  );
}

const SOURCE_FILTER_ICONS: Record<SessionSourceFilter, ComponentType<{ className?: string }>> = {
  mine: MessagesSquare,
  shared: UsersSolid,
  slack: Icon.Slack,
  email: Mail,
  schedule: CalendarClock,
  webhook: Webhook,
};

/** `size-1.5` filled dot — marks a facet's trigger row when that facet's own
 *  array is non-empty, so the collapsed submenu still signals "filtered". */
function FacetActiveDot() {
  return <span aria-hidden className="bg-foreground/60 mr-1 size-1.5 shrink-0 rounded-full" />;
}

export interface SessionFilterMenuProps {
  projectId: string;
  sessions: ProjectSession[];
  align?: 'start' | 'center' | 'end';
}

export function SessionFilterMenu({ projectId, sessions, align = 'start' }: SessionFilterMenuProps) {
  const groupMode = useSessionFilterStore((s) => s.groupByProject[projectId] ?? 'status');
  const orderMode = useSessionFilterStore((s) => s.orderByProject[projectId] ?? 'activity');
  const statusFilters = useSessionFilterStore((s) => s.statusFiltersByProject[projectId] ?? []);
  const sourceFilters = useSessionFilterStore((s) => s.sourceFiltersByProject[projectId] ?? []);
  const hiddenSections = useSessionFilterStore((s) => s.hiddenSectionsByProject[projectId] ?? []);
  const setGroupMode = useSessionFilterStore((s) => s.setGroupMode);
  const setOrderMode = useSessionFilterStore((s) => s.setOrderMode);
  const toggleStatusFilter = useSessionFilterStore((s) => s.toggleStatusFilter);
  const toggleSourceFilter = useSessionFilterStore((s) => s.toggleSourceFilter);
  const resetFilters = useSessionFilterStore((s) => s.resetFilters);
  const toggleSectionHidden = useSessionFilterStore((s) => s.toggleSectionHidden);
  const collapseAllSections = useSessionFilterStore((s) => s.collapseAllSections);

  const groupLabel = SESSION_GROUP_MODES.find((mode) => mode.value === groupMode)?.label ?? '';
  const orderLabel = SESSION_ORDER_MODES.find((mode) => mode.value === orderMode)?.label ?? '';

  const showOptions = resolveShowOptions(sessions, groupMode);
  const statusOptions = resolveStatusFacetOptions(sessions, statusFilters, sourceFilters);
  const sourceOptions = resolveSourceFacetOptions(sessions, statusFilters, sourceFilters);
  const showFiltersSection = statusOptions.length > 0 || sourceOptions.length > 0;
  const hasActiveFacets = statusFilters.length > 0 || sourceFilters.length > 0;

  return (
    <DropdownMenuContent align={align} className="w-56 p-1">
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <span className="min-w-0 flex-1 truncate">Grouping</span>
          <span className="text-muted-foreground truncate text-xs">{groupLabel}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-40 p-1">
          <DropdownMenuRadioGroup
            value={groupMode}
            onValueChange={(value) => setGroupMode(projectId, value as SessionGroupMode)}
          >
            {SESSION_GROUP_MODES.map((mode) => (
              <DropdownMenuRadioItem
                key={mode.value}
                value={mode.value}
                onSelect={(event) => event.preventDefault()}
              >
                {mode.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <span className="min-w-0 flex-1 truncate">Ordering</span>
          <span className="text-muted-foreground truncate text-xs">{orderLabel}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-40 p-1">
          <DropdownMenuRadioGroup
            value={orderMode}
            onValueChange={(value) => setOrderMode(projectId, value as SessionOrderMode)}
          >
            {SESSION_ORDER_MODES.map((mode) => (
              <DropdownMenuRadioItem
                key={mode.value}
                value={mode.value}
                onSelect={(event) => event.preventDefault()}
              >
                {mode.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      {showOptions.length > 0 && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="min-w-0 flex-1 truncate">Show</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-48 p-1">
            {showOptions.map((option) => (
              <DropdownMenuCheckboxItem
                key={option.id}
                checked={!hiddenSections.includes(option.id)}
                onCheckedChange={() => toggleSectionHidden(projectId, option.id)}
                onSelect={(event) => event.preventDefault()}
              >
                {option.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}

      {showFiltersSection && (
        <>
          <DropdownMenuSeparator />
          <div className="flex items-center justify-between gap-2 px-2.5 py-1">
            <span className="text-muted-foreground text-xs font-medium tracking-normal">
              Filters
            </span>
            <button
              type="button"
              disabled={!hasActiveFacets}
              onClick={() => resetFilters(projectId)}
              className="text-muted-foreground hover:text-foreground cursor-pointer text-xs font-medium transition-colors duration-150 ease-out disabled:pointer-events-none disabled:cursor-default disabled:opacity-40"
            >
              Reset
            </button>
          </div>

          {statusOptions.length > 0 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <span className="min-w-0 flex-1 truncate">Status</span>
                {statusFilters.length > 0 && <FacetActiveDot />}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48 p-1">
                {statusOptions.map((option) => (
                  <DropdownMenuCheckboxItem
                    key={option.value}
                    checked={statusFilters.includes(option.value)}
                    onCheckedChange={() => toggleStatusFilter(projectId, option.value)}
                    onSelect={(event) => event.preventDefault()}
                  >
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                      {option.count}
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}

          {sourceOptions.length > 0 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <span className="min-w-0 flex-1 truncate">Source</span>
                {sourceFilters.length > 0 && <FacetActiveDot />}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48 p-1">
                {sourceOptions.map((option) => {
                  const OptionIcon = SOURCE_FILTER_ICONS[option.value];
                  return (
                    <DropdownMenuCheckboxItem
                      key={option.value}
                      checked={sourceFilters.includes(option.value)}
                      onCheckedChange={() => toggleSourceFilter(projectId, option.value)}
                      onSelect={(event) => event.preventDefault()}
                    >
                      <OptionIcon className="size-4" />
                      <span className="min-w-0 flex-1 truncate">{option.label}</span>
                      <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                        {option.count}
                      </span>
                    </DropdownMenuCheckboxItem>
                  );
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
        </>
      )}

      <DropdownMenuSeparator />

      <DropdownMenuItem
        className="cursor-pointer"
        onSelect={() =>
          collapseAllSections(
            projectId,
            resolveRenderedSectionIds(sessions, groupMode, orderMode, hiddenSections),
          )
        }
      >
        Collapse all
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}
