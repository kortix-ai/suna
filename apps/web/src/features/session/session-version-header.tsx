'use client';

import { useTranslations } from 'next-intl';
/**
 * SessionVersionHeader — the top of the session's Files / Changes panel.
 *
 * It frames the surface in plain, version-first language: a **separate version**
 * of the project's main version. The agent works here without touching the live
 * version, so changes made in this session aren't in the main version until you
 * open a change request and merge them in.
 *
 * Below the framing sit two plain underline tabs (matching the panel's own tab
 * style): **All files** (default) and **Changes** (the real diff viewer).
 */

import {
  GitDiffIcon as FileDiff,
  InfoIcon as Info,
  StackIcon as Layers,
} from '@phosphor-icons/react';
import { useParams } from 'next/navigation';
import { useRef } from 'react';

import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';

import { cn } from '@/lib/utils';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  useOpenChangeRequest,
  useSessionBaseRef,
  useSessionChanges,
} from '@/features/session/session-changes-shared';

export type SessionPanelMode = 'changes' | 'files';

export type { SessionPanelMode as SessionVersionHeaderMode };

/** Tab order — drives both render order and arrow-key traversal. */
const TAB_ORDER: SessionPanelMode[] = ['files', 'changes'];

/** Stable DOM id for a tab, derived from the panel id the parent owns. */
export function sessionVersionTabId(panelId: string, mode: SessionPanelMode) {
  return `${panelId}-tab-${mode}`;
}

/** Plain underline tab — mirrors the panel header's PanelTabButton. */
function SubTab({
  active,
  onClick,
  label,
  count,
  id,
  controls,
  tabRef,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  id: string;
  controls: string;
  tabRef: (node: HTMLButtonElement | null) => void;
}) {
  return (
    <button
      ref={tabRef}
      type="button"
      role="tab"
      id={id}
      aria-controls={controls}
      aria-selected={active}
      // Roving tabIndex: the strip is one tab stop, arrows move within it.
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      className={cn(
        // Constant weight in every state — only color + the underline change,
        // so selecting a tab never shifts the layout.
        'relative inline-flex h-9 cursor-pointer items-center gap-1.5 text-sm font-medium tracking-tight transition-colors',
        active ? 'text-foreground' : 'text-muted-foreground/70 hover:text-foreground/90',
      )}
    >
      {label}
      {count !== undefined && count > 0 && (
        <Badge size="sm" variant={active ? 'secondary' : 'outline'} className="tabular-nums">
          {count}
        </Badge>
      )}
      {active && (
        <span aria-hidden className="bg-foreground absolute right-0 -bottom-px left-0 h-px" />
      )}
    </button>
  );
}

export function SessionVersionHeader({
  /** OpenCode chat session id — the agent we message to open the change request. */
  chatSessionId,
  mode,
  onModeChange,
  panelId,
}: {
  chatSessionId?: string;
  mode: SessionPanelMode;
  onModeChange: (mode: SessionPanelMode) => void;
  /** DOM id of the tab panel this strip controls — owned by the parent. */
  panelId: string;
}) {
  // The git branch == the ROUTE session id; the chat session id is passed in.

  const tI18nHardcoded = useTranslations('hardcodedUi');
  const { id: projectId, sessionId: gitSessionId } = useParams<{
    id: string;
    sessionId: string;
  }>();

  // The SAME query the Changes panel below renders — one array, so the badge
  // and the body cannot contradict each other.
  const { count: changedCount } = useSessionChanges();
  const baseRef = useSessionBaseRef(projectId, gitSessionId);

  // Short, stable handle for this version — the session id is its identity.
  const shortVersionId = gitSessionId ? gitSessionId.slice(0, 8) : '—';
  const { asking, openChangeRequest } = useOpenChangeRequest(chatSessionId, baseRef);

  const hasChanges = changedCount > 0;

  const tabRefs = useRef<Partial<Record<SessionPanelMode, HTMLButtonElement | null>>>({});
  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const current = TAB_ORDER.indexOf(mode);
    let nextIndex = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (current + 1) % TAB_ORDER.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (current - 1 + TAB_ORDER.length) % TAB_ORDER.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = TAB_ORDER.length - 1;
    }
    if (nextIndex === -1) return;
    event.preventDefault();
    const next = TAB_ORDER[nextIndex];
    onModeChange(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="border-border/60 shrink-0 border-b">
      {/* Compact header row — tabs (left) + version chip & CTA (right). */}
      <div className="flex items-center gap-3 px-4">
        {/* Tabs — All files (default) · Changes (secondary). */}
        <div
          role="tablist"
          aria-label={tI18nHardcoded.raw(
            'autoFeaturesSessionSessionVersionHeaderJsxAttrAriaLabelFiles9fd01463',
          )}
          className="flex items-center gap-5"
          onKeyDown={handleTabKeyDown}
        >
          <SubTab
            active={mode === 'files'}
            onClick={() => onModeChange('files')}
            id={sessionVersionTabId(panelId, 'files')}
            controls={panelId}
            tabRef={(node) => {
              tabRefs.current.files = node;
            }}
            label={tI18nHardcoded.raw(
              'autoFeaturesSessionSessionVersionHeaderJsxAttrLabelAllFiles4f423738',
            )}
          />
          <SubTab
            active={mode === 'changes'}
            onClick={() => onModeChange('changes')}
            id={sessionVersionTabId(panelId, 'changes')}
            controls={panelId}
            tabRef={(node) => {
              tabRefs.current.changes = node;
            }}
            label="Changes"
            count={changedCount}
          />
        </div>

        {/* Version chip + change-request CTA, right-aligned on the same row.
            On "All files" the verbose framing lives in the tooltip; on
            "Changes" it's spelled out in the explanation strip below. */}
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <Hint
            label={`Version ${shortVersionId} · alternative version of ${baseRef}`}
            side="bottom"
          >
            <span
              tabIndex={0}
              aria-label={`Version ${shortVersionId} · alternative version of ${baseRef}`}
              className="text-muted-foreground focus-visible:ring-kortix-base flex min-w-0 items-center gap-1.5 rounded-sm text-xs outline-none focus-visible:ring-[0.6px]"
            >
              <Layers className="text-muted-foreground/70 size-3.5 shrink-0" />
              <span className="text-foreground/80 truncate font-mono">{shortVersionId}</span>
            </span>
          </Hint>
          {hasChanges && (
            <Button
              size="sm"
              className="h-7 shrink-0 gap-1.5"
              onClick={openChangeRequest}
              disabled={asking}
            >
              {asking ? (
                <Loading className="size-3.5 shrink-0" />
              ) : (
                <FileDiff className="size-3.5" />
              )}
              {tI18nHardcoded.raw(
                'autoFeaturesSessionSessionVersionHeaderJsxTextOpenChangeRequesta0b45de3',
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Contextual explanation — only on the Changes tab, where the version
          framing matters most: what these changes are and how they reach main. */}
      {mode === 'changes' && (
        <div className="border-border/60 border-t px-4 py-2.5">
          <InfoBanner
            tone="neutral"
            icon={<Info className="text-muted-foreground/60 mt-px size-3.5" />}
            // Flat inline note: the strip's own top border already draws the
            // seam, so the banner keeps only its icon + text layout.
            className="items-start gap-2 border-0 bg-transparent px-0 py-0"
          >
            <p className="text-muted-foreground text-xs leading-relaxed">
              {tI18nHardcoded.raw(
                'autoFeaturesSessionSessionVersionHeaderJsxTextWhatThisSession2da8e6ce',
              )}{' '}
              <span className="text-foreground/80 font-mono">{shortVersionId}</span>{' '}
              {tI18nHardcoded.raw(
                'autoFeaturesSessionSessionVersionHeaderJsxTextASeparateVersionc3d7a454',
              )}{' '}
              <span className="text-foreground/80 font-mono">{baseRef}</span>
              {tI18nHardcoded.raw(
                'autoFeaturesSessionSessionVersionHeaderJsxTextTheseEditsStaya67c1667',
              )}{' '}
              <span className="text-foreground/80 font-mono">{baseRef}</span>{' '}
              {tI18nHardcoded.raw('autoFeaturesSessionSessionVersionHeaderJsxTextUntilYou3cf21807')}{' '}
              {hasChanges ? (
                <button
                  type="button"
                  onClick={openChangeRequest}
                  disabled={asking}
                  className="text-foreground font-medium underline decoration-dotted underline-offset-2 hover:decoration-solid disabled:opacity-60"
                >
                  {tI18nHardcoded.raw(
                    'autoFeaturesSessionSessionVersionHeaderJsxTextOpenAChange52446e59',
                  )}
                </button>
              ) : (
                <span className="text-foreground/80 font-medium">
                  {tI18nHardcoded.raw(
                    'autoFeaturesSessionSessionVersionHeaderJsxTextOpenAChange52446e59',
                  )}
                </span>
              )}{' '}
              {tI18nHardcoded.raw(
                'autoFeaturesSessionSessionVersionHeaderJsxTextToMergeThemde828b03',
              )}
            </p>
          </InfoBanner>
        </div>
      )}
    </div>
  );
}
