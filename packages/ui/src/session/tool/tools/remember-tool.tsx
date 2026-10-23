'use client';

import { ApiError, type ProjectMemoryLayerScope } from '@kortix/sdk';
import { useProjectSpaces, useUndoProjectMemoryVersion } from '@kortix/sdk/react';
import { SunDimIcon } from '@phosphor-icons/react';
import { type ReactNode, useState } from 'react';

import { useTranslations } from '../../../i18n';
import { agentDisplayName } from '../../../internal/agent-avatar';
import { uiRoutes } from '../../../lib/routes';
import { TextShimmer } from '../../../primitives/text-shimmer';
import { UiLink as Link, useUiPathname, useUiSearchParams } from '../../../providers/ui-provider';
import { useSessionIds } from '../../../providers/session-ids';
import { GenericTool } from '../generic-tool';
import { partError, partOutput, partStatus } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import type { ToolProps } from '../shared/types';

/** What the `remember` call's line shows. `other`: output this renderer does not know; the default row draws it. */
export type RememberLine =
  | { state: 'running' }
  | {
      state: 'saved';
      pageId: string;
      versionId: string;
      title: string;
      layer: { scope: ProjectMemoryLayerScope; name: string; key: string };
    }
  | { state: 'failed'; reason: string }
  | { state: 'other' };

const SCOPES: readonly string[] = ['company', 'channel', 'dm'];

/** `Error: <code>: <message>` (kortixd's refusal text) → the message, else the text after `Error:`. */
function refusalReason(text: string): string {
  const rest = text.replace(/^Error:\s*/i, '');
  const match = /^[a-z0-9_]+:\s*([\s\S]+)$/i.exec(rest);
  return (match?.[1] ?? rest).trim();
}

/**
 * The line for a `remember` call, from its status and output. The tool
 * returns the API's `MemoryRememberResult` as JSON, or `Error: code: message`
 * for a refusal; anything else is `other`.
 */
export function rememberLine(status: string, output: string, error?: string): RememberLine {
  if (status === 'pending' || status === 'running') return { state: 'running' };
  if (status === 'error') return { state: 'failed', reason: refusalReason(error ?? '') };
  const text = output.trim();
  if (/^Error:/i.test(text)) return { state: 'failed', reason: refusalReason(text) };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { state: 'other' };
  }
  const result = value as Record<string, unknown> | null;
  const layer = result?.layer as Record<string, unknown> | undefined;
  if (
    result?.saved !== true ||
    typeof result.page_id !== 'string' ||
    typeof result.version_id !== 'string' ||
    typeof result.title !== 'string' ||
    typeof layer?.name !== 'string' ||
    typeof layer.key !== 'string' ||
    !SCOPES.includes(layer.scope as string)
  ) {
    return { state: 'other' };
  }
  return {
    state: 'saved',
    pageId: result.page_id,
    versionId: result.version_id,
    title: result.title,
    layer: { scope: layer.scope as ProjectMemoryLayerScope, name: layer.name, key: layer.key },
  };
}

type UndoState = 'idle' | 'pending' | 'undone' | 'superseded' | 'failed';

const LINK =
  'text-foreground focus-visible:ring-ring rounded-sm font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 disabled:opacity-50';

/** The line itself, without data hooks: "Saved to #marketing memory: Q4 launch · View · Undo". */
export function RememberLineView({
  line,
  viewHref,
  undo,
  onUndo,
}: {
  line: Exclude<RememberLine, { state: 'other' }>;
  /** The page in its Memory tab; null hides View. */
  viewHref: string | null;
  undo: UndoState;
  onUndo: () => void;
}) {
  const t = useTranslations('spaces.memory.saved');
  let text: ReactNode;
  if (line.state === 'running') {
    text = <TextShimmer className="min-w-0 truncate text-xs">{t('running')}</TextShimmer>;
  } else if (line.state === 'failed') {
    text = <span className="min-w-0 [overflow-wrap:anywhere]">{t('failed', { reason: line.reason })}</span>;
  } else {
    const key = line.layer.scope === 'company' ? 'company' : line.layer.scope === 'dm' ? 'dm' : 'channel';
    text = (
      <span className="min-w-0 truncate">
        {undo === 'undone'
          ? t('undone')
          : t.rich(key, {
              place: line.layer.scope === 'dm' ? agentDisplayName(line.layer.name) : line.layer.name,
              title: line.title,
              page: (chunks) => <span className="text-foreground">{chunks}</span>,
            })}
      </span>
    );
  }
  const view = viewHref ? (
    <Link href={viewHref} className={LINK}>
      {undo === 'superseded' ? t('openHistory') : t('view')}
    </Link>
  ) : null;
  return (
    <div className="text-muted-foreground flex max-w-full items-center gap-1.5 py-0.5 text-xs">
      <SunDimIcon aria-hidden className="size-4 shrink-0" />
      {text}
      {line.state === 'saved' && undo !== 'undone' ? (
        <>
          {undo === 'superseded' ? <span className="shrink-0">· {t('superseded')}</span> : view ? <span aria-hidden>·</span> : null}
          {view}
          {undo === 'superseded' ? null : (
            <>
              <span aria-hidden>·</span>
              <button
                type="button"
                className={LINK}
                disabled={undo === 'pending'}
                aria-busy={undo === 'pending' || undefined}
                onClick={onUndo}
              >
                {t('undo')}
              </button>
            </>
          )}
          {undo === 'failed' ? (
            <span role="alert" className="text-destructive shrink-0">
              {t('undoFailed')}
            </span>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * Where View opens the page: its channel's or DM's Memory tab with `?page=`.
 * Company pages open in the current channel or DM's Memory tab until the
 * project Memory page exists (P2). A space of the page the reader is on keeps
 * the open thread beside it.
 */
function useViewHref(line: RememberLine): string | null {
  const projectId = useSessionIds().projectId;
  const pathname = useUiPathname();
  const searchParams = useUiSearchParams();
  const saved = line.state === 'saved' ? line : null;
  const spaces = useProjectSpaces(projectId, { enabled: !!saved && saved.layer.scope !== 'company' });
  if (!saved || !projectId) return null;
  let path: string | null = null;
  if (saved.layer.scope === 'company') {
    path = /\/projects\/[^/]+\/(c|dm)\/[^/]+$/.test(pathname) ? pathname : null;
  } else {
    const space = spaces.data?.find((candidate) => candidate.space_id === saved.layer.key);
    if (space?.kind === 'channel' && space.slug) path = uiRoutes().channel(projectId, space.slug);
    else if (space?.kind === 'dm' && space.dm_agent_name) path = uiRoutes().dm(projectId, space.dm_agent_name);
  }
  if (!path) return null;
  const here = pathname === path || pathname.endsWith(path);
  const params = new URLSearchParams(here ? searchParams.toString() : '');
  params.set('tab', 'memory');
  params.set('page', saved.pageId);
  return `${here ? pathname : path}?${params.toString()}`;
}

/** A `remember` call: one quiet line, no card. Output it cannot read falls back to the default row. */
export function RememberTool(props: ToolProps) {
  const { call } = props;
  const line = rememberLine(partStatus(call), partOutput(call), partError(call));
  const projectId = useSessionIds().projectId ?? '';
  const undo = useUndoProjectMemoryVersion(projectId);
  const [undoState, setUndoState] = useState<UndoState>('idle');
  const viewHref = useViewHref(line);
  if (line.state === 'other') return <GenericTool {...props} />;
  const runUndo = () => {
    if (line.state !== 'saved' || undo.isPending) return;
    setUndoState('pending');
    undo.mutate(line.versionId, {
      onSuccess: () => setUndoState('undone'),
      onError: (err) =>
        setUndoState(
          err instanceof ApiError && err.code === 'superseded'
            ? 'superseded'
            : err instanceof ApiError && err.code === 'already_undone'
              ? 'undone'
              : 'failed',
        ),
    });
  };
  return <RememberLineView line={line} viewHref={viewHref} undo={undoState} onUndo={runUndo} />;
}

ToolRegistry.register('remember', RememberTool);
