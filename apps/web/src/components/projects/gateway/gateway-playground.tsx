'use client';

import { useState } from 'react';
import { DangerTriangle as AlertTriangle, ClockCircle as Clock, Dollar as Coins, CornerDownLeft, Sparkles, Zap } from '@mynaui/icons-react';
import { DEFAULT_MANAGED_MODEL_IDS } from '@kortix/shared/llm-catalog';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useGatewayPlayground } from '@/hooks/projects/use-project-gateway';
import type { GatewayPlaygroundResult } from '@/lib/projects-gateway-client';

import { CopyButton, MetricBar, modelAccent, modelLabel, tint } from './_shared';

const QUICK_MODELS = [...DEFAULT_MANAGED_MODEL_IDS];

const EXAMPLES = [
  'Explain transformers like I am five',
  'Write a haiku about databases',
  'Summarize the trade-offs of microservices',
  'Turn this idea into a product tagline',
];

export function GatewayPlayground({ projectId }: { projectId: string }) {
  const run = useGatewayPlayground(projectId);
  const [prompt, setPrompt] = useState('');
  const [selected, setSelected] = useState<string[]>(QUICK_MODELS.slice(0, 3));

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length < 6 ? [...s, id] : s));

  const results = run.data?.results ?? [];
  const canRun = prompt.trim().length > 0 && selected.length > 0 && !run.isPending;
  const start = () => canRun && run.mutate({ prompt: prompt.trim(), models: selected });
  const estTokens = Math.max(1, Math.ceil(prompt.trim().length / 4));

  const ok = results.filter((r) => r.ok && typeof r.latency_ms === 'number');
  const fastest = ok.length ? ok.reduce((a, b) => ((a.latency_ms ?? 0) <= (b.latency_ms ?? 0) ? a : b)) : null;
  const leanest = ok.length ? ok.reduce((a, b) => ((a.output_tokens ?? 0) <= (b.output_tokens ?? 0) ? a : b)) : null;
  const maxLatency = Math.max(1, ...ok.map((r) => r.latency_ms ?? 0));
  const maxTokens = Math.max(1, ...ok.map((r) => r.output_tokens ?? 0));

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-5 p-5">
        <div className="overflow-hidden rounded-2xl border border-border/60 bg-card">
          <div className="flex items-center justify-between border-b border-border/50 px-4 py-2.5">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary" />
              <span className="text-sm font-medium text-foreground">Prompt</span>
            </div>
            <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
              <kbd className="flex items-center gap-0.5 rounded-md border border-border/60 bg-muted px-1.5 py-0.5 font-mono text-xs">
                ⌘<CornerDownLeft className="size-3" />
              </kbd>
              to run
            </span>
          </div>

          <div className="space-y-3 p-4">
            <Textarea
              rows={4}
              placeholder="Ask anything…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  start();
                }
              }}
            />
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => setPrompt(ex)}
                  className="rounded-full border border-dashed border-border/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors duration-150 hover:border-border hover:text-foreground"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>

          <div className="border-t border-border/50 px-4 py-3">
            <div className="mb-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground/60">
              Models
            </div>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_MODELS.map((id) => {
                const on = selected.includes(id);
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => toggle(id)}
                    className={cn(
                      'group inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-all duration-150',
                      on
                        ? 'border-transparent bg-primary/10 text-primary'
                        : 'border-border/60 text-muted-foreground hover:border-border hover:text-foreground',
                    )}
                  >
                    <span
                      className="size-2 rounded-full transition-transform duration-150 group-hover:scale-125"
                      style={{ backgroundColor: modelAccent(id), opacity: on ? 1 : 0.5 }}
                    />
                    {modelLabel(id)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-border/50 bg-muted/30 px-4 py-3">
            <span className="text-xs text-muted-foreground">
              {selected.length}/6 models · ~{estTokens.toLocaleString()} prompt tokens
            </span>
            <Button disabled={!canRun} onClick={start} className="gap-1.5">
              {run.isPending ? (
                <>
                  <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  Running
                </>
              ) : (
                <>
                  <Zap className="size-3.5" />
                  Run
                </>
              )}
            </Button>
          </div>
        </div>

        {ok.length > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            {fastest && (
              <SummaryPill icon={Clock} label="Fastest" value={`${modelLabel(fastest.model)} · ${fastest.latency_ms}ms`} accent={modelAccent(fastest.model)} />
            )}
            {leanest && (
              <SummaryPill icon={Coins} label="Most concise" value={`${modelLabel(leanest.model)} · ${leanest.output_tokens ?? 0} tok`} accent={modelAccent(leanest.model)} />
            )}
          </div>
        )}

        {(run.isPending || results.length > 0) && (
          <div className="grid gap-4 lg:grid-cols-2">
            {run.isPending
              ? selected.map((m, i) => <ResultCard key={m} result={{ model: m, ok: true }} loading index={i} />)
              : results.map((r, i) => (
                  <ResultCard
                    key={r.model}
                    result={r}
                    index={i}
                    isFastest={fastest?.model === r.model && ok.length > 1}
                    latencyPct={((r.latency_ms ?? 0) / maxLatency) * 100}
                    tokenPct={((r.output_tokens ?? 0) / maxTokens) * 100}
                  />
                ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryPill({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-card py-1 pl-1.5 pr-3">
      <span
        className="flex size-5 items-center justify-center rounded-full"
        style={{ backgroundColor: tint(accent, 14), color: accent }}
      >
        <Icon className="size-3" />
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-medium text-foreground">{value}</span>
    </div>
  );
}

function ResultCard({
  result,
  loading,
  index,
  isFastest,
  latencyPct,
  tokenPct,
}: {
  result: GatewayPlaygroundResult;
  loading?: boolean;
  index: number;
  isFastest?: boolean;
  latencyPct?: number;
  tokenPct?: number;
}) {
  const accent = modelAccent(result.model);
  return (
    <div
      className="group animate-in fade-in-0 slide-in-from-bottom-2 rounded-2xl border border-border/60 bg-card p-4 transition-colors duration-200 fill-mode-both hover:border-border"
      style={{ animationDelay: `${index * 70}ms` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: accent }} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-foreground">{modelLabel(result.model)}</span>
              {isFastest && (
                <span className="rounded-full bg-kortix-green/15 px-1.5 py-0.5 text-xs font-medium text-kortix-green">
                  Fastest
                </span>
              )}
            </div>
            <div className="truncate font-mono text-xs text-muted-foreground">{result.model}</div>
          </div>
        </div>
        {!loading && result.ok && result.output ? <CopyButton text={result.output} className="opacity-0 transition-opacity group-hover:opacity-100" /> : null}
      </div>

      <div className="mt-3">
        {loading ? (
          <div className="space-y-2">
            <div className="h-3 w-3/4 animate-pulse rounded-full bg-muted" />
            <div className="h-3 w-full animate-pulse rounded-full bg-muted" />
            <div className="h-3 w-2/3 animate-pulse rounded-full bg-muted" />
          </div>
        ) : result.ok ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {result.output || <span className="text-muted-foreground">(empty response)</span>}
          </p>
        ) : (
          <div className="flex items-start gap-2 rounded-xl border border-border/60 bg-muted/40 p-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-kortix-orange" />
            <p className="text-sm text-muted-foreground">{result.error ?? 'Request failed'}</p>
          </div>
        )}
      </div>

      {!loading && result.ok && (
        <div className="mt-3 space-y-1.5 border-t border-border/50 pt-3">
          <MetricBar icon={Clock} value={`${result.latency_ms ?? 0}ms`} pct={latencyPct ?? 0} accent={accent} />
          <MetricBar icon={Coins} value={`${(result.output_tokens ?? 0).toLocaleString()} tok`} pct={tokenPct ?? 0} accent={accent} />
        </div>
      )}
    </div>
  );
}
