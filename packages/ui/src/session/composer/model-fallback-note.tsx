'use client';

import type { FlatModel, ModelKey, SessionModelFallback } from '@kortix/sdk';
import { ArrowsSplitIcon } from '@phosphor-icons/react';

import { Button } from '../../primitives/button';
import { useTranslations } from '../../i18n';

/** Codes `servedModelReason` has no word for that mean "this model is not served". */
const UNAVAILABLE = new Set(['model_not_found', 'model_retired', 'model_disabled_on_deployment']);

const nameOf = (models: FlatModel[], key: ModelKey) =>
  models.find((m) => m.providerID === key.providerID && m.modelID === key.modelID)?.modelName ?? key.modelID;

/**
 * The composer's model was switched to a fallback because the session's own
 * model could not serve. Says which, why, and offers the way back. Self-hides
 * (renders nothing) when there is no switch, so the input strip stays empty.
 */
export function ModelFallbackNote({
  fallback,
  models,
  onUse,
}: {
  fallback: SessionModelFallback | undefined;
  models: FlatModel[];
  onUse: (model: ModelKey) => void;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  if (!fallback) return null;
  const requested = nameOf(models, fallback.from);
  const reason = t('servedModelReason', {
    reason: UNAVAILABLE.has(fallback.reason) ? 'model_unavailable' : fallback.reason,
  });
  return (
    <div role="status" data-testid="model-fallback-note" className="flex w-full items-center gap-2 py-0.5 pr-1 pl-2">
      <ArrowsSplitIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
        {t('servedModelFallbackNote', { served: nameOf(models, fallback.model), requested, reason })}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="text-muted-foreground hover:text-foreground shrink-0"
        onClick={() => onUse(fallback.from)}
      >
        {t('servedModelFallbackUse', { requested })}
      </Button>
    </div>
  );
}
