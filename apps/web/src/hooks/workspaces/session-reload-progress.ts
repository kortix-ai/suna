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

export function reloadProgressText(phase: SessionReloadPhase | null): string {
  if (!phase) return 'Preparing reload';
  return RELOAD_PROGRESS_STEPS.find((step) => step.phase === phase)?.label ?? 'Reloading config';
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
