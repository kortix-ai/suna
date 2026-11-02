'use client';

import { useMemo } from 'react';
import type { SessionUsage, SessionUsageEntry } from '@kortix/sdk';
import { useTranslations } from '../../i18n';
import { agentDisplayName } from '../../internal/components/agent-mark';
import { HoverPrefetchLink } from '../../internal/components/hover-prefetch-link';
import { formatSessionCostUsd } from '../../internal/billing/session-cost-format';
import { projectSessionHref } from '../../internal/lib/navigation/session-href';
import { Label } from '../../primitives/label';

/**
 * The sessions this session spawned (`parent_session_id`, e.g. `kortix sessions
 * create` from inside it), and the ones they spawned, with what each cost.
 * The rows are the API's ledger read (`useSessionUsage`): the session first,
 * then its descendants depth-first.
 */
export function SpawnedSessionSection({
  usage,
  projectId,
  onNavigate,
}: {
  usage: SessionUsage | undefined;
  projectId: string;
  /** A row's link was followed: close the view. */
  onNavigate?: () => void;
}) {
  const t = useTranslations('hardcodedUi.componentsSessionSessionContextModal');
  const children = useMemo(() => {
    const map = new Map<string, SessionUsageEntry[]>();
    for (const entry of usage?.sessions.slice(1) ?? []) {
      if (!entry.parent_session_id) continue;
      const list = map.get(entry.parent_session_id) ?? [];
      list.push(entry);
      map.set(entry.parent_session_id, list);
    }
    return map;
  }, [usage]);

  if (!usage || (usage.sessions.length < 2 && usage.hidden_sessions === 0)) return null;
  const root = usage.sessions[0];
  const spawned = usage.sessions.length - 1;

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <Label>{t.raw('spawnedLabel')}</Label>
        <p className="text-muted-foreground text-xs">{t.raw('spawnedNote')}</p>
      </div>
      <div className="bg-popover rounded-md border">
        <div className="text-muted-foreground grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-6 border-b px-4 py-2 text-xs">
          <span>{t('spawnedCount', { count: spawned })}</span>
          <span className="text-right">{t.raw('spawnedRequests')}</span>
          <span className="w-20 text-right">{t.raw('spawnedCost')}</span>
        </div>
        <div className="px-2 py-2">
          <UsageRow entry={root} projectId={projectId} label={t.raw('spawnedThisSession')} />
          {(children.get(root.session_id) ?? []).map((entry) => (
            <UsageTreeNode key={entry.session_id} entry={entry} childMap={children} projectId={projectId} onNavigate={onNavigate} />
          ))}
        </div>
        <div className="text-foreground grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-6 border-t px-4 py-2 text-xs font-medium">
          <span>{t.raw('spawnedTotal')}</span>
          <span className="text-right tabular-nums">{usage.total.request_count.toLocaleString()}</span>
          <span className="w-20 text-right tabular-nums">{formatSessionCostUsd(usage.total.cost)}</span>
        </div>
      </div>
      {usage.hidden_sessions > 0 && (
        <p className="text-muted-foreground text-xs">{t('spawnedHidden', { count: usage.hidden_sessions })}</p>
      )}
      {usage.truncated && <p className="text-muted-foreground text-xs">{t.raw('spawnedTruncated')}</p>}
    </section>
  );
}

function UsageTreeNode({
  entry,
  childMap,
  projectId,
  onNavigate,
}: {
  entry: SessionUsageEntry;
  childMap: ReadonlyMap<string, SessionUsageEntry[]>;
  projectId: string;
  onNavigate?: () => void;
}) {
  const children = childMap.get(entry.session_id) ?? [];
  return (
    <div className="border-border/30 ml-4 flex flex-col border-l pl-3">
      <UsageRow entry={entry} projectId={projectId} onNavigate={onNavigate} />
      {children.map((child) => (
        <UsageTreeNode key={child.session_id} entry={child} childMap={childMap} projectId={projectId} onNavigate={onNavigate} />
      ))}
    </div>
  );
}

/** One session: its name (a link to it, except for the session being viewed), requests and cost. */
function UsageRow({
  entry,
  projectId,
  label,
  onNavigate,
}: {
  entry: SessionUsageEntry;
  projectId: string;
  /** Shown instead of a link: the session being viewed. */
  label?: string;
  onNavigate?: () => void;
}) {
  const t = useTranslations('hardcodedUi.componentsSessionSessionContextModal');
  const name = entry.title ?? t.raw('spawnedUntitled');
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-6 rounded-md px-2 py-1.5 text-xs">
      <span className="flex min-w-0 items-baseline gap-2">
        {label ? (
          <span className="text-foreground truncate font-medium">{label}</span>
        ) : (
          <HoverPrefetchLink
            href={projectSessionHref(projectId, entry.session_id)}
            onClick={onNavigate}
            className="text-foreground truncate font-medium underline-offset-2 hover:underline"
          >
            {name}
          </HoverPrefetchLink>
        )}
        {entry.agent_name && (
          <span className="text-muted-foreground shrink-0 truncate">{agentDisplayName(entry.agent_name)}</span>
        )}
      </span>
      <span className="text-muted-foreground text-right tabular-nums">{entry.request_count.toLocaleString()}</span>
      <span className="text-foreground w-20 text-right tabular-nums">{formatSessionCostUsd(entry.cost)}</span>
    </div>
  );
}
