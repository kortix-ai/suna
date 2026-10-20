'use client';

import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from '../../../../i18n';
import { useLocalizedUiCatalog } from '../../../../i18n/ui-catalog/use-localized-ui-catalog';
import { type ReactNode, useMemo, useState } from 'react';

import {
  useGatewayBreakdown,
  useGatewayErrors,
  useGatewayOverview,
  useGatewaySeries,
  useGatewaySessions,
} from '@kortix/sdk/react';
import type { GatewayModelStat } from '@kortix/sdk';
import { listProjectSessions, PROJECT_SESSION_NAME_LOOKUP_LIMIT } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { cn } from '../../../../internal/lib/utils';

import {
  CostPanel,
  CostSection,
  MetricTab,
  RangeSelector,
  ShareBar,
  UsageChart,
  chartConfig,
  fmtCompact,
  fmtCredits,
  fmtMs,
  weightedP50,
} from './_metrics';
import { displayModel } from './_shared';
import { GatewayBudgetSection } from './gateway-budgets';

type MetricKey = 'cost' | 'traffic' | 'tokens' | 'latency';

const METRICS: {
  key: MetricKey;
  label: string;
  keys: (keyof typeof chartConfig)[];
  fmt: (v: number) => string;
}[] = [
  // Spend reads in credits; the tooltip appends the unit in the component.
  { key: 'cost', label: 'Spend', keys: ['cost'], fmt: (v) => fmtCredits(v) },
  {
    key: 'traffic',
    label: 'Requests',
    keys: ['requests', 'errors'],
    fmt: (v) => v.toLocaleString(),
  },
  { key: 'tokens', label: 'Tokens', keys: ['input_tokens', 'output_tokens'], fmt: fmtCompact },
  {
    key: 'latency',
    label: 'Latency',
    keys: ['p50', 'p95', 'p99'],
    fmt: (v) => `${fmtCompact(v)}ms`,
  },
];

/** Models that make the "Most spend" list by name; the rest fold into one row. */
const MOST_SPEND_ROWS = 5;

/**
 * Top models by spend, with everything past the first few folded into one
 * "everything else" row so the list always adds up to the window's spend.
 */
export function mostSpend(models: readonly GatewayModelStat[], rows = MOST_SPEND_ROWS) {
  const sorted = [...models].sort((a, b) => b.cost - a.cost);
  const total = sorted.reduce((sum, m) => sum + m.cost, 0);
  const named = sorted.slice(0, rows);
  const rest = sorted.slice(rows).reduce((sum, m) => sum + m.cost, 0);
  const share = (cost: number) => (total > 0 ? Math.round((cost / total) * 100) : 0);
  return {
    named: named.map((m) => ({ model: m, share: share(m.cost) })),
    rest: sorted.length > rows ? { cost: rest, share: share(rest) } : null,
  };
}

/**
 * Costs — the gateway's analytics for the window: one card whose header IS
 * the metric picker (Spend, Requests, Tokens, Latency — each with its window
 * total), the chart for the picked metric under it, and plain hairline lists
 * below: where the money went, the cap on it, the member caps, the sessions
 * that cost most, and what failed.
 *
 * The four stat cards that used to sit above a separate chart panel restated
 * the same totals the chart's metric tabs then switched between. They are one
 * control now: the tab carries the total and the chart carries the shape.
 */
export function GatewayOverview({
  projectId,
  canWrite = false,
}: {
  projectId: string;
  /** Gates the budget controls. Read-only members still see the cap. */
  canWrite?: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('gatewayCosts');
  const metrics = useLocalizedUiCatalog(METRICS);
  const locale = useLocale();
  const creditsUnit = tI18nComplete.raw('textbe379a30f1aa');
  const credits = (usd: number) => fmtCredits(usd, locale);
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState<MetricKey>('cost');

  const { data: overview } = useGatewayOverview(projectId, days);
  const { data: seriesData } = useGatewaySeries(projectId, days);
  const { data: breakdown } = useGatewayBreakdown(projectId, days);
  const { data: sessionsData } = useGatewaySessions(projectId, days);
  const { data: errorData } = useGatewayErrors(projectId, days);

  // Resolve session ids → human names so spend reads as "Fix login bug", not a
  // raw uuid. Map both the kortix and opencode ids since the gateway may key on
  // either.
  const { data: projectSessions } = useQuery({
    queryKey: qk.project.sessions(projectId),
    queryFn: () => listProjectSessions(projectId, { limit: PROJECT_SESSION_NAME_LOOKUP_LIMIT }),
    enabled: !!projectId,
    ...contract('inventory'),
  });
  const sessionNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of projectSessions ?? []) {
      const label = s.name ?? s.custom_name ?? null;
      if (!label) continue;
      m.set(s.session_id, label);
      const runtimeSessionId = s.runtime_session_id ?? s.opencode_session_id;
      if (runtimeSessionId) m.set(runtimeSessionId, label);
    }
    return m;
  }, [projectSessions]);

  const requests = overview?.requests ?? 0;
  const errors = overview?.errors ?? 0;
  // Total spend regardless of who collected it. `kortix_cost` is what came out
  // of the Kortix wallet; `provider_cost` is what went straight to your own
  // provider on your own key. A BYOK project spends entirely on the second,
  // which is why this headline used to read $0.0000 forever.
  const cost = overview?.total_cost ?? 0;
  const kortixCost = overview?.kortix_cost ?? 0;
  const providerCost = overview?.provider_cost ?? 0;
  const inTokens = overview?.input_tokens ?? 0;
  const outTokens = overview?.output_tokens ?? 0;

  const series = seriesData?.series ?? [];
  const latency = weightedP50(series);

  const spend = mostSpend(breakdown?.models ?? []);
  const sessions = (sessionsData?.sessions ?? []).slice(0, 6);
  const maxSessionCost = Math.max(1e-9, ...sessions.map((s) => s.total_cost));
  const errorTypes = errorData?.errors ?? [];
  const maxErrorCount = Math.max(1, ...errorTypes.map((e) => e.count));

  const activeMetric = metrics.find((m) => m.key === metric) ?? metrics[0];
  const tab = (key: MetricKey) => metrics.find((m) => m.key === key)?.label ?? key;

  const tabs: { key: MetricKey; value: string; unit?: string; sub: ReactNode }[] = [
    {
      key: 'cost',
      value: credits(cost),
      unit: creditsUnit,
      sub: <SpendSplit kortixCost={kortixCost} providerCost={providerCost} days={days} />,
    },
    {
      key: 'traffic',
      value: requests.toLocaleString(),
      sub: requests
        ? `${t('perDay', { count: Math.round(requests / Math.max(1, days)) })} · ${t('errorsRate', {
            count: errors,
            rate: ((errors / requests) * 100).toFixed(1),
          })}`
        : tI18nComplete.raw('texte191ab529417'),
    },
    {
      key: 'tokens',
      value: fmtCompact(inTokens + outTokens),
      sub: t('tokensSub', { in: fmtCompact(inTokens), out: fmtCompact(outTokens) }),
    },
    {
      key: 'latency',
      value: latency == null ? '—' : fmtMs(latency),
      sub: latency == null ? tI18nComplete.raw('texte191ab529417') : t('latencySub'),
    },
  ];

  return (
    // No scroller and no padding of its own: this is a tab of
    // `/projects/[id]/models`, and `CapabilityPageShell` owns the page's one
    // scroll container and its column.
    <div className="flex flex-col">
      <div className="w-full space-y-12">
        {/* The metric picker IS the chart's header: each tab carries its
            window total, the chart below carries the shape. */}
        <section className="border-border bg-surface overflow-hidden rounded-xl border">
          <div className="border-border flex flex-col border-b sm:flex-row">
            <div
              role="tablist"
              aria-label={tI18nComplete.raw('text9e217716c4e0')}
              className="flex min-w-0 flex-1"
            >
              {tabs.map((m) => (
                <MetricTab
                  key={m.key}
                  label={tab(m.key)}
                  value={m.value}
                  unit={m.unit}
                  selected={metric === m.key}
                  onSelect={() => setMetric(m.key)}
                />
              ))}
            </div>
            <div className="border-border flex items-center border-t px-4 py-3 sm:border-t-0 sm:border-l sm:py-0">
              <RangeSelector days={days} setDays={setDays} />
            </div>
          </div>
          <div className="space-y-2 px-5 pt-6 pb-4">
            {/* The picked metric's one line of context — who was paid, the
                error rate, the in/out split — read with its chart. */}
            <p className="text-muted-foreground text-xs tabular-nums">
              {tabs.find((m) => m.key === metric)?.sub}
            </p>
            <UsageChart
              data={series}
              keys={activeMetric.keys}
              yFormatter={
                activeMetric.key === 'cost'
                  ? (v) => `${credits(v)} ${creditsUnit}`
                  : activeMetric.fmt
              }
            />
          </div>
        </section>

        {/* The cap on the spend directly under the chart, with the member
            caps under it — before the breakdowns. */}
        <GatewayBudgetSection projectId={projectId} canWrite={canWrite} />

        <div className="flex flex-col gap-4 lg:flex-row">
          <CostSection title={t('mostSpend')} description={t('mostSpendHint')}>
            <CostPanel>
              {spend.named.length === 0 ? (
                <p className="text-muted-foreground flex h-10 items-center text-xs">
                  {tI18nComplete.raw('textea923f45a415')}
                </p>
              ) : (
                <>
                  {spend.named.map(({ model, share }) => (
                    <SpendRow
                      key={`${model.provider}/${model.model}`}
                      label={displayModel(model.model) || 'unknown'}
                      value={`${credits(model.cost)} ${creditsUnit} · ${share}%`}
                    />
                  ))}
                  {spend.rest ? (
                    <SpendRow
                      label={t('everythingElse')}
                      value={`${credits(spend.rest.cost)} ${creditsUnit} · ${spend.rest.share}%`}
                    />
                  ) : null}
                </>
              )}
            </CostPanel>
          </CostSection>

          <CostSection title={tI18nComplete.raw('textfec78985c8f3')} description={t('sessionsHint')}>
            <CostPanel>
              {sessions.length === 0 ? (
                <p className="text-muted-foreground flex h-10 items-center text-xs">
                  {tI18nComplete.raw('text0e25da739ad6')}
                </p>
              ) : (
                sessions.map((s) => {
                  const name = sessionNames.get(s.session_id);
                  return (
                    <div
                      key={s.session_id}
                      className="border-border flex min-h-13 items-center gap-4 border-b py-2 last:border-b-0"
                      data-session-row=""
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span
                          className={cn(
                            'text-foreground truncate text-xs',
                            !name && 'font-mono',
                          )}
                        >
                          {name ?? s.session_id.slice(0, 8)}
                        </span>
                        <span className="text-muted-foreground truncate text-xs tabular-nums">
                          {name ? <span className="font-mono">{s.session_id.slice(0, 8)} · </span> : null}
                          {t('sessionModel', { cost: credits(s.llm_cost) })} ·{' '}
                          {t('sessionSandbox', { cost: credits(s.compute_cost) })} ·{' '}
                          {s.requests.toLocaleString()} {tI18nComplete.raw('textc3f7bdf537c4')}
                        </span>
                      </div>
                      <ShareBar
                        className="w-24"
                        segments={[
                          { pct: (s.llm_cost / maxSessionCost) * 100, color: 'var(--kortix-blue)' },
                          {
                            pct: (s.compute_cost / maxSessionCost) * 100,
                            color: 'var(--muted-foreground)',
                          },
                        ]}
                      />
                      <span className="text-foreground w-14 shrink-0 text-right text-xs font-medium tabular-nums">
                        {credits(s.total_cost)}
                      </span>
                    </div>
                  );
                })
              )}
            </CostPanel>
          </CostSection>
        </div>

        {errorTypes.length > 0 ? (
          <CostSection
            title={tI18nComplete.raw('text431a387a9976')}
            description={t('errorsHint')}
            action={
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                {t('errorsTotal', { count: errorTypes.reduce((sum, e) => sum + e.count, 0) })}
              </span>
            }
          >
            <CostPanel>
              {errorTypes.map((e) => (
                <div
                  key={e.code}
                  className="border-border flex h-10 items-center gap-4 border-b last:border-b-0"
                >
                  <span className="text-foreground min-w-0 flex-1 truncate font-mono text-xs">
                    {e.code}
                  </span>
                  <ShareBar
                    className="w-40"
                    segments={[{ pct: (e.count / maxErrorCount) * 100, color: 'var(--destructive)' }]}
                  />
                  <span className="text-foreground w-8 shrink-0 text-right text-xs tabular-nums">
                    {e.count.toLocaleString()}
                  </span>
                </div>
              ))}
            </CostPanel>
          </CostSection>
        ) : null}
      </div>
    </div>
  );
}

/** One "Most spend" row: a model and its spend with its share of the window. */
function SpendRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border flex h-10 items-center justify-between gap-3 border-b last:border-b-0">
      <span className="text-foreground min-w-0 truncate text-xs">{label}</span>
      <span className="text-foreground shrink-0 text-xs tabular-nums">{value}</span>
    </div>
  );
}

/**
 * Who actually collected the money behind the Spend total.
 *
 * Two payees, never more: the Kortix wallet (managed inference, or the
 * platform fee on a BYOK route) and your own provider account (BYOK, billed
 * to your own key). A payee that collected nothing is left out rather than
 * printed as a `0` — on the two common deployments (all-managed and
 * all-BYOK) exactly one side is real, and naming it is more useful than a
 * two-term sum with a zero in it.
 */
function SpendSplit({
  kortixCost,
  providerCost,
  days,
}: {
  kortixCost: number;
  providerCost: number;
  days: number;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  if (kortixCost > 0 && providerCost > 0) {
    return (
      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <Payee
          color="var(--kortix-blue)"
          label={tI18nComplete.raw('textab54cf5e1d9d')}
          amount={kortixCost}
        />
        <span>·</span>
        <Payee
          color="var(--muted-foreground)"
          label={tI18nComplete.raw('text1e19bab29bc6')}
          amount={providerCost}
        />
      </span>
    );
  }
  if (providerCost > 0) return <>{tI18nComplete.raw('text192173c3beda')}</>;
  if (kortixCost > 0) return <>{tI18nComplete.raw('textea13cd34d9e0')}</>;
  return (
    <>
      {tI18nComplete.raw('text5fb6a47e368e')} {days} {tI18nComplete.raw('textab51004e9d71')}
    </>
  );
}

/** Bare credits: the Spend tab above carries the unit. */
function Payee({ color, label, amount }: { color: string; label: string; amount: number }) {
  const locale = useLocale();
  return (
    <span className="inline-flex items-center gap-1 tabular-nums">
      <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      {fmtCredits(amount, locale)} {label}
    </span>
  );
}
