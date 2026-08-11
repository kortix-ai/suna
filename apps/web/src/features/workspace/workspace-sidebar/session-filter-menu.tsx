'use client';

import type { ComponentType } from 'react';

import {
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import {
  matchesSourceFilters,
  matchesStatusFilters,
  SESSION_SOURCE_FILTERS,
  SESSION_STATUS_FILTERS,
  type SessionSourceFilter,
  type SessionStatusFilter,
} from '@/components/workspaces/session-label';
import { Slack } from '@/features/icon/icons/slack';
import { Telegram } from '@/features/icon/icons/telegram';
import {
  selectGroupMode,
  selectHiddenSections,
  selectOrderMode,
  selectSourceFilters,
  selectStatusFilters,
  useSessionFilterStore,
  type SessionViewSurface,
} from '@/stores/session-filter-store';
import type { WorkspaceSession } from '@kortix/sdk';
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
 * `reviewCountBySession` defaults to `{}` for callers that don't have it
 * (e.g. a test that only cares about non-`status` modes), but the component
 * below always threads the real review-center summary through: without it,
 * `status` mode's `needs-you` bucket is always empty (`sessionDisplayStatus`
 * only returns `'needs-you'` when a session's own review count is > 0), so
 * `groupSessions` drops the section and the user has no way to hide/show it.
 */
export function resolveShowOptions(
  sessions: WorkspaceSession[],
  mode: SessionGroupMode,
  reviewCountBySession: Record<string, number> = {},
): SessionFilterShowOption[] {
  return groupSessions(sessions, {
    mode,
    order: 'activity',
    reviewCountBySession,
  }).sections.map((section) => ({ id: section.id, label: section.label }));
}

/** The section ids that would actually render right now — mode, order, review
 *  state, and hidden state all applied. What `Collapse all` collapses. Same
 *  `reviewCountBySession` default and rationale as `resolveShowOptions`: pass
 *  the real summary so `needs-you` participates in "collapse everything". */
export function resolveRenderedSectionIds(
  sessions: WorkspaceSession[],
  mode: SessionGroupMode,
  order: SessionOrderMode,
  hiddenSections: readonly string[],
  reviewCountBySession: Record<string, number> = {},
): string[] {
  return groupSessions(sessions, {
    mode,
    order,
    reviewCountBySession,
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
  facetedSessions: WorkspaceSession[],
  matchesOne: (session: WorkspaceSession, value: V) => boolean,
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
  sessions: WorkspaceSession[],
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
  sessions: WorkspaceSession[],
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
  slack: Slack,
  telegram: Telegram,
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
  workspaceId: string;
  sessions: WorkspaceSession[];
  align?: 'start' | 'center' | 'end';
  /** Defaults to `right`, which is correct for the sidebar's triggers. A
   *  toolbar trigger at the top of a full-width page passes `bottom` so the
   *  menu drops under the button instead of relying on collision-flipping. */
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** Which list this menu drives. The two surfaces share this component but NOT
   *  their state — narrowing the sessions page must not narrow the sidebar you
   *  navigate with. A surface with no choice of its own inherits the sidebar's,
   *  so the page opens matching the sidebar and diverges on first change. */
  surface?: SessionViewSurface;
  /** Review-center `needs_you` counts, keyed by session id. Optional and
   *  defaulted to `{}` so existing call sites keep compiling, but a caller
   *  that has the review summary (the sidebar does) should always pass it:
   *  without it, `status` grouping's `needs-you` section can never appear in
   *  `Show` or be reached by `Collapse all`. */
  reviewCountBySession?: Record<string, number>;
}

export function SessionFilterMenu({
  workspaceId,
  sessions,
  align = 'start',
  side = 'right',
  surface = 'sidebar',
  reviewCountBySession = {},
}: SessionFilterMenuProps) {
  const groupMode = useSessionFilterStore(selectGroupMode(workspaceId, surface));
  const orderMode = useSessionFilterStore(selectOrderMode(workspaceId, surface));
  const statusFilters = useSessionFilterStore(selectStatusFilters(workspaceId, surface));
  const sourceFilters = useSessionFilterStore(selectSourceFilters(workspaceId, surface));
  const hiddenSections = useSessionFilterStore(selectHiddenSections(workspaceId, surface));
  const setGroupMode = useSessionFilterStore((s) => s.setGroupMode);
  const setOrderMode = useSessionFilterStore((s) => s.setOrderMode);
  const toggleStatusFilter = useSessionFilterStore((s) => s.toggleStatusFilter);
  const toggleSourceFilter = useSessionFilterStore((s) => s.toggleSourceFilter);
  const resetFilters = useSessionFilterStore((s) => s.resetFilters);
  const toggleSectionHidden = useSessionFilterStore((s) => s.toggleSectionHidden);
  const collapseAllSections = useSessionFilterStore((s) => s.collapseAllSections);

  const groupLabel = SESSION_GROUP_MODES.find((mode) => mode.value === groupMode)?.label ?? '';
  const orderLabel = SESSION_ORDER_MODES.find((mode) => mode.value === orderMode)?.label ?? '';

  const showOptions = resolveShowOptions(sessions, groupMode, reviewCountBySession);
  const statusOptions = resolveStatusFacetOptions(sessions, statusFilters, sourceFilters);
  const sourceOptions = resolveSourceFacetOptions(sessions, statusFilters, sourceFilters);
  const showFiltersSection = statusOptions.length > 0 || sourceOptions.length > 0;
  const hasActiveFacets = statusFilters.length > 0 || sourceFilters.length > 0;

  return (
    <DropdownMenuContent align={align} side={side} className="w-56 p-1">
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <span className="min-w-0 flex-1 truncate">Grouping</span>
          <span className="text-muted-foreground truncate text-xs">{groupLabel}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-40 p-1">
          <DropdownMenuRadioGroup
            value={groupMode}
            onValueChange={(value) => setGroupMode(workspaceId, value as SessionGroupMode, surface)}
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
            onValueChange={(value) => setOrderMode(workspaceId, value as SessionOrderMode, surface)}
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
                onCheckedChange={() => toggleSectionHidden(workspaceId, option.id, surface)}
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
          <div className="flex items-center justify-between gap-2 pr-1">
            <DropdownMenuLabel className="flex-1">Filters</DropdownMenuLabel>
            <DropdownMenuItem
              disabled={!hasActiveFacets}
              className="text-muted-foreground w-auto shrink-0 cursor-pointer justify-end px-2 text-xs font-medium"
              onSelect={(event) => {
                // Reset stays legible without collapsing the menu the user is
                // mid-adjustment in — same "stay open" contract as every
                // checkbox row below.
                event.preventDefault();
                resetFilters(workspaceId, surface);
              }}
            >
              Reset
            </DropdownMenuItem>
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
                    onCheckedChange={() => toggleStatusFilter(workspaceId, option.value, surface)}
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
                      onCheckedChange={() => toggleSourceFilter(workspaceId, option.value, surface)}
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
            workspaceId,
            resolveRenderedSectionIds(
              sessions,
              groupMode,
              orderMode,
              hiddenSections,
              reviewCountBySession,
            ),
            surface,
          )
        }
      >
        Collapse all
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}
