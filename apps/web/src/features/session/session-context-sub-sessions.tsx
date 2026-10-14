'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { useTranslations } from '@/i18n/use-translations';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { useSessionLogThread, useSessionSync, type SessionMessagesSource } from '@kortix/sdk/react';
import { CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react';
import { allDescendantIds, childMapByParent, formatCost, sessionLogThreadMetrics, type ModelPricingLookup, type Session, type SessionLogThread, type SessionLogThreadMetrics } from '@kortix/sdk';

// ============================================================================
// Thread metrics
// ============================================================================

export const NO_METRICS: SessionLogThreadMetrics = {
  cost: 0,
  messages: { all: 0, user: 0, assistant: 0 },
  tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  context: null,
};

/** The SDK's metrics of a thread the store may not hold yet. */
export function threadMetrics(thread: SessionLogThread | null, pricingLookup: ModelPricingLookup): SessionLogThreadMetrics {
  return thread ? sessionLogThreadMetrics(thread, { pricing: pricingLookup }) : NO_METRICS;
}

export function sumMetrics(all: SessionLogThreadMetrics[]): SessionLogThreadMetrics {
  const sum: SessionLogThreadMetrics = { ...NO_METRICS, messages: { ...NO_METRICS.messages }, tokens: { ...NO_METRICS.tokens } };
  for (const m of all) {
    sum.cost += m.cost;
    for (const k of ['all', 'user', 'assistant'] as const) sum.messages[k] += m.messages[k];
    for (const k of Object.keys(sum.tokens) as Array<keyof SessionLogThreadMetrics['tokens']>) sum.tokens[k] += m.tokens[k];
  }
  return sum;
}

// ============================================================================
// Sub-session tree component
// ============================================================================

/** The metrics of every descendant thread, by runtime session id. */
type MetricsById = Readonly<Record<string, SessionLogThreadMetrics>>;

/**
 * Reads the thread of every id in `ids` through `useSessionLogThread`, one
 * component per id (a hook per thread, no loop), and renders `children` with
 * the metrics of all of them. A pure derivation: no state, no effect, so the
 * totals never depend on which rows are expanded.
 */
function WithThreadMetrics({
  source,
  ids,
  pricingLookup,
  acc = {},
  children,
}: {
  source: SessionMessagesSource;
  ids: readonly string[];
  pricingLookup: ModelPricingLookup;
  acc?: MetricsById;
  children: (metrics: MetricsById) => ReactNode;
}) {
  if (ids.length === 0) return <>{children(acc)}</>;
  return (
    <WithOneThread source={source} id={ids[0]} rest={ids.slice(1)} pricingLookup={pricingLookup} acc={acc}>
      {children}
    </WithOneThread>
  );
}

function WithOneThread({
  source,
  id,
  rest,
  pricingLookup,
  acc,
  children,
}: {
  source: SessionMessagesSource;
  id: string;
  rest: readonly string[];
  pricingLookup: ModelPricingLookup;
  acc: MetricsById;
  children: (metrics: MetricsById) => ReactNode;
}) {
  const thread = useSessionLogThread(source, id);
  const metrics = useMemo(() => threadMetrics(thread, pricingLookup), [thread, pricingLookup]);
  const next = useMemo(() => ({ ...acc, [id]: metrics }), [acc, id, metrics]);
  return (
    <WithThreadMetrics source={source} ids={rest} pricingLookup={pricingLookup} acc={next}>
      {children}
    </WithThreadMetrics>
  );
}

/**
 * Loads a sub-agent's thread into the store, as the sub-agent's own view does (`useSessionSync`
 * with `savedChild`): its saved window, then the runtime's. The section mounts one per requested
 * id (a row that scrolled into view, or "Load all"), outside the tree, so collapsing a row
 * does not unload its children.
 */
function LoadSubAgentThread({ id, scope }: { id: string; scope: string | undefined }) {
  useSessionSync(id, { kortixSessionScope: scope, savedChild: true, subscribeMessages: false });
  return null;
}

/** One sub-agent's row: its thread's metrics, and its own children under it. */
function SubSessionTreeNode({
  id,
  depth = 0,
  childMap,
  allSessions,
  metrics,
  messagesSuffix,
  requested,
  onSeen,
}: {
  id: string;
  depth?: number;
  childMap: Map<string, string[]>;
  allSessions: Session[];
  metrics: MetricsById;
  messagesSuffix: string;
  /** The ids whose thread the section loads. */
  requested: ReadonlySet<string>;
  /** The row has been in view: load its thread (about 2 requests). */
  onSeen: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const rowRef = useRef<HTMLButtonElement>(null);
  const isRequested = requested.has(id);
  useEffect(() => {
    const row = rowRef.current;
    if (isRequested || !row) return;
    if (typeof IntersectionObserver === 'undefined') {
      onSeen(id);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onSeen(id);
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, [id, isRequested, onSeen]);
  const own = metrics[id] ?? NO_METRICS;
  const title = allSessions.find((s) => s.id === id)?.title ?? id.slice(0, 12);
  const children = childMap.get(id) ?? [];
  const hasChildren = children.length > 0;

  return (
    <div className={cn('flex flex-col', depth > 0 && 'border-border/30 ml-4 border-l pl-3')}>
      <button
        ref={rowRef}
        onClick={() => hasChildren && setExpanded(!expanded)}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
          hasChildren && 'hover:bg-muted/40 cursor-pointer',
          !hasChildren && 'cursor-default',
        )}
      >
        {hasChildren ? (
          expanded ? (
            <CaretDownIcon className="text-muted-foreground size-3 shrink-0" />
          ) : (
            <CaretRightIcon className="text-muted-foreground size-3 shrink-0" />
          )
        ) : (
          <div className="size-3 shrink-0" />
        )}
        <span className="text-foreground min-w-0 truncate font-medium">{title}</span>
        <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
          {own.messages.all} {messagesSuffix}
        </span>
        <span className="text-muted-foreground shrink-0 tabular-nums">{formatCost(own.cost)}</span>
      </button>
      {expanded && hasChildren && (
        <div className="flex flex-col">
          {children.map((childId) => (
            <SubSessionTreeNode
              key={childId}
              id={childId}
              depth={depth + 1}
              childMap={childMap}
              allSessions={allSessions}
              metrics={metrics}
              messagesSuffix={messagesSuffix}
              requested={requested}
              onSeen={onSeen}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function SubSessionSection({ source, session, allSessions, pricingLookup, fmt }: {
  /** The session whose log the root thread and each sub-agent's thread read. */
  source: SessionMessagesSource;
  session: Session | undefined;
  allSessions: Session[] | undefined;
  pricingLookup: ModelPricingLookup;
  fmt: { number: (value: number | null | undefined) => string };
}) {
  const t = useTranslations('hardcodedUi.componentsSessionSessionContextModal');
  const childMap = useMemo(
    () => (allSessions ? childMapByParent(allSessions) : new Map<string, string[]>()),
    [allSessions],
  );

  const descendantIds = useMemo(
    () => (session ? allDescendantIds(childMap, session.id) : []),
    [childMap, session],
  );

  // The root's own metrics, plus every descendant's (the whole tree, whatever
  // is expanded): the combined totals read the same records the rows do.
  const root = useSessionLogThread(source);
  const scope = source.projectId && source.sessionId ? `${source.projectId}/${source.sessionId}` : undefined;
  const rootMetrics = useMemo(() => threadMetrics(root, pricingLookup), [root, pricingLookup]);
  // A row's thread loads once the row has been in view, or on "Load all"; kept while the modal is open.
  const [requested, setRequested] = useState<ReadonlySet<string>>(() => new Set());
  const onSeen = useCallback((id: string) => setRequested((prev) => (prev.has(id) ? prev : new Set(prev).add(id))), []);
  const loadAll = useCallback(() => setRequested(new Set(descendantIds)), [descendantIds]);
  const loaded = descendantIds.filter((id) => requested.has(id)).length;

  if (!session || !allSessions || descendantIds.length === 0) return null;

  return (
    <WithThreadMetrics source={source} ids={descendantIds} pricingLookup={pricingLookup}>
      {(metrics) => {
        const totals = sumMetrics([rootMetrics, ...descendantIds.map((id) => metrics[id] ?? NO_METRICS)]);
        return (
          <section className="space-y-3">
            {[...requested].map((id) => (
              <LoadSubAgentThread key={id} id={id} scope={scope} />
            ))}
            <div className="space-y-1">
              <Label>{t.raw('subAgentsLabel')}</Label>
              <p className="text-muted-foreground text-xs">{t.raw('subAgentsNote')}</p>
              {loaded < descendantIds.length && (
                <div className="flex items-center gap-2">
                  <p className="text-muted-foreground text-xs tabular-nums">
                    {t('subAgentsLoaded', { loaded, total: descendantIds.length })}
                  </p>
                  <Button variant="outline" size="xs" onClick={loadAll}>
                    {t('loadAll')}
                  </Button>
                </div>
              )}
            </div>
            <div className="bg-popover rounded-md border">
              <div className="grid grid-cols-2 gap-4 px-4 py-4 lg:grid-cols-4">
                <Stat label={t.raw('combinedCost')} value={formatCost(totals.cost)} />
                <Stat label={t.raw('combinedMessages')} value={totals.messages.all.toLocaleString()} />
                <Stat label={t.raw('tokensIn')} value={fmt.number(totals.tokens.input)} />
                <Stat label={t.raw('tokensOut')} value={fmt.number(totals.tokens.output)} />
              </div>
              <div className="border-t px-2 py-2">
                {(childMap.get(session.id) ?? []).map((childId) => (
                  <SubSessionTreeNode
                    key={childId}
                    id={childId}
                    childMap={childMap}
                    allSessions={allSessions}
                    metrics={metrics}
                    messagesSuffix={t.raw('treeMessages')}
                    requested={requested}
                    onSeen={onSeen}
                  />
                ))}
              </div>
            </div>
          </section>
        );
      }}
    </WithThreadMetrics>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="text-foreground truncate text-xs font-medium tabular-nums">{value}</div>
    </div>
  );
}
