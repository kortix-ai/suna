'use client';

/**
 * Playground — run one prompt against several models side by side and compare
 * output, tokens, cost, and latency. Thin client over the gateway's built-in
 * `POST /gateway/playground` endpoint (see `useGatewayPlayground`); the
 * backend runs every model concurrently and returns once all finish, so there
 * is a single "running" state rather than per-model streaming.
 */

import { AlertTriangle, Clock, Coins, Play, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent } from '@/components/ui/disclosure';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { errorToast } from '@/components/ui/toast';
import { ModelSelector } from '@/features/session/model-selector';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import { modelKeyToWire, wireToModelKey } from '@/hooks/opencode/use-model-store';
import { useGatewayPlayground } from '@/hooks/projects/use-project-gateway';
import type {
  GatewayModelGenerationConfig,
  GatewayPlaygroundResult,
} from '@/lib/projects-gateway-client';
import { cn } from '@/lib/utils';
import { useProjectModels } from '@kortix/sdk/react';

import { displayModel } from './_shared';
import { fmtUsd } from './_metrics';
import { GenerationControlsPanel } from './generation-controls';

const MAX_MODELS = 6;

type PlaygroundModel = ReturnType<typeof useProjectModels>[number];

function PlaygroundModelSelector({
  value,
  models,
  exclude = [],
  unsetLabel = 'Choose model',
  disabled,
  onChange,
}: {
  value: string | null;
  models: PlaygroundModel[];
  exclude?: string[];
  unsetLabel?: string;
  disabled?: boolean;
  onChange: (value: string | null) => void;
}) {
  const options = models.filter((model) => {
    const wire = modelKeyToWire(model);
    return !exclude.includes(wire) || wire === value;
  });
  return (
    <ModelSelector
      models={options}
      selectedModel={value ? wireToModelKey(value) : null}
      unsetLabel={unsetLabel}
      disabled={disabled}
      onSelect={(model) => onChange(model ? modelKeyToWire(model) : null)}
    />
  );
}

export function fmtLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** One model's result — output, usage, cost, latency, or the error it hit.
 *  Exported standalone (no hooks) so it renders and tests without a query
 *  client. */
export function PlaygroundResultCard({ result }: { result: GatewayPlaygroundResult }) {
  const title = displayModel(result.resolved_model ?? result.model);
  return (
    <section className="bg-popover flex flex-col overflow-hidden rounded-md border">
      <div className="border-border/60 flex items-center justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <p className="text-foreground truncate text-sm font-medium">{title}</p>
          {result.resolved_model && result.resolved_model !== result.model ? (
            <p className="text-muted-foreground truncate font-mono text-xs">{result.model}</p>
          ) : null}
        </div>
        <Badge variant={result.ok ? 'success' : 'destructive'} size="sm" className="shrink-0">
          {result.ok ? 'OK' : 'Failed'}
        </Badge>
      </div>
      <div className="flex-1 space-y-3 px-4 py-4">
        {result.ok ? (
          <p className="text-foreground max-h-64 overflow-y-auto text-sm whitespace-pre-wrap text-pretty">
            {result.output?.trim() || <span className="text-muted-foreground">Empty response.</span>}
          </p>
        ) : (
          <InfoBanner tone="destructive" icon={AlertTriangle} title="Request failed">
            {result.error ?? 'Unknown error.'}
          </InfoBanner>
        )}
        <InlineMeta className="border-border/60 border-t pt-3">
          {result.latency_ms != null ? (
            <span className="inline-flex items-center gap-1 tabular-nums">
              <Clock className="size-3 shrink-0" />
              {fmtLatency(result.latency_ms)}
            </span>
          ) : null}
          {result.input_tokens != null || result.output_tokens != null ? (
            <span className="tabular-nums">
              {result.input_tokens ?? 0} in · {result.output_tokens ?? 0} out
            </span>
          ) : null}
          {result.cost != null ? (
            <span className="inline-flex items-center gap-1 tabular-nums">
              <Coins className="size-3 shrink-0" />
              {fmtUsd(result.cost)}
            </span>
          ) : null}
        </InlineMeta>
      </div>
    </section>
  );
}

export function GatewayPlayground({ projectId }: { projectId: string }) {
  const catalogModels = useProjectModels(projectId);
  const playground = useGatewayPlayground(projectId);

  const [prompt, setPrompt] = useState('');
  const [system, setSystem] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  // Per-model generation-parameter overrides for this run only — never
  // persisted (unlike the routing section's project-default config). Keyed
  // by wire model id so removing/re-adding a model keeps its tuning.
  const [generationConfig, setGenerationConfig] = useState<
    Record<string, GatewayModelGenerationConfig>
  >({});
  const [tunedModel, setTunedModel] = useState<string | null>(null);

  const models = useMemo(
    () => catalogModels.filter((model) => modelKeyToWire(model) !== 'auto'),
    [catalogModels],
  );

  const canAddMore =
    selected.length < MAX_MODELS && models.some((model) => !selected.includes(modelKeyToWire(model)));
  const canRun = prompt.trim().length > 0 && selected.length > 0 && !playground.isPending;
  const results = playground.data?.results ?? null;

  const run = () => {
    playground.mutate(
      {
        prompt: prompt.trim(),
        models: selected,
        system: system.trim() || undefined,
        generationConfig,
      },
      {
        onError: (error) =>
          errorToast(error instanceof Error ? error.message : 'Playground run failed'),
      },
    );
  };

  return (
    <CustomizeSectionWrapper
      title="Playground"
      description="Run one prompt across several models and compare output, cost, and latency side by side."
    >
      <div className="space-y-8">
        <section className="space-y-4">
          <Label>Prompt</Label>
          <div className="bg-popover space-y-3 rounded-md border px-4 py-5">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ask something to compare across models…"
              minHeight={96}
              maxHeight={280}
              disabled={playground.isPending}
            />
            {showSystem ? (
              <div className="space-y-1.5">
                <Label className="text-muted-foreground text-xs font-normal">System prompt</Label>
                <Textarea
                  value={system}
                  onChange={(e) => setSystem(e.target.value)}
                  placeholder="Optional system instructions sent to every model"
                  minHeight={60}
                  maxHeight={160}
                  variant="secondary"
                  disabled={playground.isPending}
                />
              </div>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground -ml-2 w-fit"
                onClick={() => setShowSystem(true)}
                disabled={playground.isPending}
              >
                <Plus className="size-3.5 shrink-0" />
                Add system prompt
              </Button>
            )}
          </div>
        </section>

        <section className="space-y-4">
          <Label>
            Models
            <span className="text-muted-foreground font-normal">
              {' '}
              ({selected.length}/{MAX_MODELS})
            </span>
          </Label>

          {selected.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Choose up to {MAX_MODELS} models to compare on this prompt.
            </p>
          ) : (
            <ul className="space-y-2">
              {selected.map((wire, index) => {
                const tuned = generationConfig[wire];
                const tunedCount = tuned ? Object.keys(tuned).length : 0;
                const open = tunedModel === wire;
                return (
                  <li key={`${wire}-${index}`} className="bg-popover overflow-hidden rounded-md border">
                    <div className="flex items-center gap-2 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <PlaygroundModelSelector
                          value={wire}
                          models={models}
                          exclude={selected.filter((_, i) => i !== index)}
                          disabled={playground.isPending}
                          onChange={(next) => {
                            if (!next) return;
                            setSelected((current) =>
                              current.map((m, i) => (i === index ? next : m)),
                            );
                          }}
                        />
                      </div>
                      <Hint label="Tune generation parameters for this model">
                        <Button
                          type="button"
                          size="icon-sm"
                          variant={open ? 'secondary' : 'ghost'}
                          aria-label="Tune generation parameters"
                          disabled={playground.isPending}
                          onClick={() => setTunedModel(open ? null : wire)}
                        >
                          <SlidersHorizontal className="size-3.5" />
                        </Button>
                      </Hint>
                      {tunedCount > 0 ? (
                        <Badge variant="secondary" size="xs" className="shrink-0">
                          {tunedCount}
                        </Badge>
                      ) : null}
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Remove model"
                        disabled={playground.isPending}
                        onClick={() => {
                          setSelected((current) => current.filter((_, i) => i !== index));
                          setGenerationConfig((current) => {
                            if (!(wire in current)) return current;
                            const { [wire]: _removed, ...rest } = current;
                            return rest;
                          });
                          setTunedModel((current) => (current === wire ? null : current));
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                    <Disclosure variant="outline" open={open}>
                      <DisclosureContent variant="outline" contentClassName="border-border border-t">
                        <div className="px-3 py-4">
                          <GenerationControlsPanel
                            model={wire}
                            value={generationConfig[wire]}
                            disabled={playground.isPending}
                            onChange={(next) =>
                              setGenerationConfig((current) => ({ ...current, [wire]: next }))
                            }
                          />
                        </div>
                      </DisclosureContent>
                    </Disclosure>
                  </li>
                );
              })}
            </ul>
          )}

          {canAddMore ? (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">Add model</span>
              <PlaygroundModelSelector
                value={null}
                models={models}
                exclude={selected}
                unsetLabel="Choose model"
                disabled={playground.isPending}
                onChange={(next) => next && setSelected((current) => [...current, next])}
              />
            </div>
          ) : null}
        </section>

        <div className="bg-background/95 sticky bottom-0 -mx-4 flex items-center justify-between gap-4 border-t px-4 py-4 backdrop-blur">
          <div className="text-muted-foreground text-xs">
            {playground.isPending
              ? `Running against ${selected.length} model${selected.length === 1 ? '' : 's'}…`
              : results
                ? `Last run · ${results.length} result${results.length === 1 ? '' : 's'}`
                : 'Nothing run yet'}
          </div>
          <Button type="button" disabled={!canRun} onClick={run}>
            {playground.isPending ? (
              <Loading className="size-4 shrink-0" />
            ) : (
              <Play className="size-3.5 shrink-0" />
            )}
            Run
          </Button>
        </div>

        {playground.isPending ? (
          <div className={cn('grid gap-4', selected.length > 1 && 'lg:grid-cols-2')}>
            {selected.map((wire) => (
              <Skeleton key={wire} className="h-48 rounded-md" />
            ))}
          </div>
        ) : results && results.length > 0 ? (
          <div className={cn('grid gap-4', results.length > 1 && 'lg:grid-cols-2')}>
            {results.map((result, index) => (
              <PlaygroundResultCard key={`${result.model}-${index}`} result={result} />
            ))}
          </div>
        ) : null}
      </div>
    </CustomizeSectionWrapper>
  );
}
