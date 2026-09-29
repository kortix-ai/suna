import {
  SESSION_ACTIVITY_SECTIONS,
  sessionActivitySectionOf,
  sessionDisplayTitle,
  sessionLastActivityAt,
  type ProjectSession,
} from '@kortix/sdk';

import { sessionDisplayStatus, sessionSource } from '@/components/projects/session-label';
import { localizeUiCatalog } from '@/i18n/localize-ui-catalog';
import { PRODUCT_CATALOG_TRANSLATION_KEYS } from '@/i18n/product-catalog-translation-keys.generated';
import type { UiTranslator } from '@/i18n/translator';

import {
  resolveOwnerFacetOptions,
  sessionOwnerKey,
  UNKNOWN_OWNER_KEY,
} from '../project-sessions/session-owner-filters';

/** Section id for one owner in `owner` grouping mode. */
export function ownerSectionId(ownerKey: string): string {
  return `owner:${ownerKey}`;
}

/**
 * Owner-mode sections are the one grouping that comes from the DATA, not a
 * declared constant: there is one section per person. The order is still fixed
 * and data-independent in shape — the viewer first, then by name, the unknown
 * owner last (`resolveOwnerFacetOptions`) — so sections never reshuffle as
 * sessions update.
 */
function ownerSections(
  sessions: readonly ProjectSession[],
  labels: { you?: string; unknown?: string },
): Array<{ id: string; label: string }> {
  return resolveOwnerFacetOptions(sessions, []).map((owner) => ({
    id: ownerSectionId(owner.value),
    label: owner.isViewer
      ? (labels.you ?? owner.name ?? owner.email ?? owner.value)
      : owner.value === UNKNOWN_OWNER_KEY
        ? (labels.unknown ?? owner.value)
        : (owner.name ?? owner.email ?? owner.value),
  }));
}

/**
 * General session grouper behind the sidebar's `Grouping ›` / `Ordering ›`
 * filter menu. Four grouping modes, three ordering modes, all composable.
 *
 * `status` mode is the sidebar's original three-section split: membership is
 * decided by display status, and `needs-you` wins outright over every other
 * signal.
 *
 * `activity` and `source` modes do NOT give review state that same veto —
 * review-pending sessions group by their date or their source like any other
 * session, and the review state itself shows on the row's status dot.
 */

export type SessionGroupMode = 'status' | 'activity' | 'source' | 'owner' | 'none';
export type SessionOrderMode = 'activity' | 'created' | 'name';

export const DEFAULT_SESSION_GROUP_MODE: SessionGroupMode = 'activity';

export const SESSION_GROUP_MODES: Array<{ value: SessionGroupMode; label: string }> = [
  { value: 'status', label: 'Status' },
  { value: 'activity', label: 'Activity' },
  { value: 'source', label: 'Source' },
  { value: 'owner', label: 'Owner' },
  { value: 'none', label: 'None' },
];

export const SESSION_ORDER_MODES: Array<{ value: SessionOrderMode; label: string }> = [
  { value: 'activity', label: 'Last activity' },
  { value: 'created', label: 'Date created' },
  { value: 'name', label: 'Name' },
];

export function localizedSessionGroupModes(tI18nComplete: UiTranslator) {
  return localizeUiCatalog(SESSION_GROUP_MODES, tI18nComplete, PRODUCT_CATALOG_TRANSLATION_KEYS);
}

export function localizedSessionOrderModes(tI18nComplete: UiTranslator) {
  return localizeUiCatalog(SESSION_ORDER_MODES, tI18nComplete, PRODUCT_CATALOG_TRANSLATION_KEYS);
}

/** Status-mode section ids — kept as its own union for callers that only ever
 *  see status-mode sections. */
export type SessionSectionId = 'needs-you' | 'running' | 'recent';

export interface SessionSection {
  /** Stable across renders — the store keys collapsed/hidden state by it. */
  id: string;
  label: string;
  /** Open-ended tails (recent/older/all) don't get a count: it's noise. */
  sessions: ProjectSession[];
}

export interface GroupedSessions {
  sections: SessionSection[];
  /** False when at most one section is populated: a header divides, and one
   *  header divides nothing. Keeps a new project from looking like chrome. */
  showHeaders: boolean;
}

const STATUS_SECTION_ORDER: Array<{ id: SessionSectionId; label: string }> = [
  { id: 'needs-you', label: 'Needs you' },
  { id: 'running', label: 'Running' },
  { id: 'recent', label: 'Recent' },
];

const SOURCE_SECTION_ORDER: Array<{ id: string; label: string }> = [
  { id: 'chat', label: 'Chat' },
  { id: 'slack', label: 'Slack' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'teams', label: 'Teams' },
  { id: 'email', label: 'Email' },
  { id: 'schedule', label: 'Scheduled' },
  { id: 'webhook', label: 'Webhook' },
];

const NONE_SECTION_ORDER: Array<{ id: string; label: string }> = [{ id: 'all', label: 'All' }];

function statusBucketFor(session: ProjectSession, reviewCount: number): SessionSectionId {
  const display = sessionDisplayStatus(session, reviewCount);
  if (display === 'needs-you') return 'needs-you';
  if (display === 'running' || display === 'starting') return 'running';
  return 'recent';
}

function orderComparator(
  order: SessionOrderMode,
  lastActivityMsBySession: Map<string, number>,
): (a: ProjectSession, b: ProjectSession) => number {
  if (order === 'created') {
    return (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  }
  if (order === 'name') {
    return (a, b) =>
      sessionDisplayTitle(a).localeCompare(sessionDisplayTitle(b), undefined, {
        sensitivity: 'base',
      });
  }
  return (a, b) =>
    (lastActivityMsBySession.get(b.session_id) ?? 0) -
    (lastActivityMsBySession.get(a.session_id) ?? 0);
}

/**
 * Split `sessions` into sections per `options.mode`, ordered within each
 * section per `options.order`. Never mutates `sessions`.
 *
 * Section order always comes from a declared constant for the mode — never
 * from iteration order over the data — so the sidebar renders sections in a
 * stable, predictable sequence regardless of which sessions happen to exist.
 */
export function groupSessions(
  sessions: ProjectSession[],
  options: {
    mode: SessionGroupMode;
    order: SessionOrderMode;
    reviewCountBySession: Record<string, number>;
    hiddenSections?: readonly string[];
    now?: number;
    /** Translated labels for the viewer's and the unknown owner's sections in
     *  `owner` mode. Every other owner is labelled by name or email. */
    ownerLabels?: { you?: string; unknown?: string };
  },
  tI18nComplete: UiTranslator,
): GroupedSessions {
  const { mode, order, reviewCountBySession, hiddenSections, now = Date.now() } = options;
  const hidden = new Set(hiddenSections ?? []);

  // Precompute last-activity once per session (decorate-sort-undecorate):
  // sessionLastActivityAt re-scans opencode_sessions, so calling it inside a
  // comparator would repeat that scan O(n log n) times instead of O(n).
  const lastActivityMsBySession = new Map(
    sessions.map((session) => [session.session_id, sessionLastActivityAt(session)]),
  );

  const ordered = sessions.slice().sort(orderComparator(order, lastActivityMsBySession));

  const statusSections = localizeUiCatalog(
    STATUS_SECTION_ORDER,
    tI18nComplete,
    PRODUCT_CATALOG_TRANSLATION_KEYS,
  );
  const activitySections = localizeUiCatalog(
    SESSION_ACTIVITY_SECTIONS,
    tI18nComplete,
    PRODUCT_CATALOG_TRANSLATION_KEYS,
  );
  const sourceSections = localizeUiCatalog(
    SOURCE_SECTION_ORDER,
    tI18nComplete,
    PRODUCT_CATALOG_TRANSLATION_KEYS,
  );
  const allSections = localizeUiCatalog(
    NONE_SECTION_ORDER,
    tI18nComplete,
    PRODUCT_CATALOG_TRANSLATION_KEYS,
  );
  const declared =
    mode === 'status'
      ? statusSections
      : mode === 'activity'
        ? activitySections
        : mode === 'source'
          ? sourceSections
          : mode === 'owner'
            ? ownerSections(sessions, options.ownerLabels ?? {})
            : allSections;

  const buckets = new Map<string, ProjectSession[]>(declared.map((section) => [section.id, []]));

  for (const session of ordered) {
    const bucketId: string =
      mode === 'status'
        ? statusBucketFor(session, reviewCountBySession[session.session_id] ?? 0)
        : mode === 'activity'
          ? sessionActivitySectionOf(lastActivityMsBySession.get(session.session_id) ?? 0, now)
          : mode === 'source'
            ? sessionSource(session, tI18nComplete).kind
            : mode === 'owner'
              ? ownerSectionId(sessionOwnerKey(session))
              : 'all';
    buckets.get(bucketId)?.push(session);
  }

  const sections: SessionSection[] = [];
  for (const section of declared) {
    if (hidden.has(section.id)) continue;
    const bucket = buckets.get(section.id) ?? [];
    if (bucket.length === 0) continue;
    sections.push({ ...section, sessions: bucket });
  }

  return { sections, showHeaders: sections.length > 1 };
}
