import { translateUiCatalogText } from '@/i18n/localize-ui-catalog';
import { REMAINING_UI_TRANSLATION_KEYS } from '@/i18n/remaining-ui-translation-keys.generated';
import type { UiTranslator } from '@/i18n/translator';
import type { SessionReloadPhase } from '@kortix/sdk';

export const RELOAD_PROGRESS_STEPS: ReadonlyArray<{
  phase: SessionReloadPhase;
  label: string;
}> = [
  { phase: 'checking-session', label: 'Checking session' },
  { phase: 'refreshing-workspace', label: 'Refreshing workspace' },
  { phase: 'compiling-config', label: 'Compiling agent config' },
  { phase: 'applying-config', label: 'Applying config and validating runtime' },
  { phase: 'confirming-config', label: 'Confirming active config' },
];

export type ReloadProgressPosition = 'complete' | 'current' | 'pending' | 'skipped';

export function reloadProgressText(
  phase: SessionReloadPhase | null,
  tI18nComplete?: UiTranslator,
): string {
  const text = phase
    ? (RELOAD_PROGRESS_STEPS.find((step) => step.phase === phase)?.label ?? 'Reloading config')
    : 'Preparing reload';
  return tI18nComplete
    ? translateUiCatalogText(text, tI18nComplete, REMAINING_UI_TRANSLATION_KEYS)
    : text;
}

export function reloadProgressPosition(
  current: SessionReloadPhase | null,
  step: SessionReloadPhase,
  refreshRepo = true,
): ReloadProgressPosition {
  if (!refreshRepo && step === 'refreshing-workspace') return 'skipped';
  if (!current) return 'pending';

  const currentIndex = RELOAD_PROGRESS_STEPS.findIndex((item) => item.phase === current);
  const stepIndex = RELOAD_PROGRESS_STEPS.findIndex((item) => item.phase === step);
  if (stepIndex < currentIndex) return 'complete';
  if (stepIndex === currentIndex) return 'current';
  return 'pending';
}
