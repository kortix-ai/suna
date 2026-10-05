import type { UiTranslator } from '@/i18n/translator';
import type { SandboxTemplate } from '@kortix/sdk';
import { useTranslations } from '@/i18n/use-translations';

import { Badge } from '@/components/ui/badge';

export type ProviderCoverageEntry = NonNullable<SandboxTemplate['provider_coverage']>[number];
export type ProviderCoverageStatus = ProviderCoverageEntry['status'];
export type SandboxProvider = ProviderCoverageEntry['provider'];

export type SandboxProviderMode = 'automatic' | 'pinned';

export function sandboxProviderLabel(provider: SandboxProvider): 'Daytona' | 'Platinum' | 'E2B' {
  switch (provider) {
    case 'daytona':
      return 'Daytona';
    case 'platinum':
      return 'Platinum';
    case 'e2b':
      return 'E2B';
  }
}

export function describeProviderMode(
  mode: SandboxProviderMode,
  selectedProvider: SandboxProvider | null,
  tI18nComplete: UiTranslator,
): { label: string; selectedProvider: string | null } {
  if (mode === 'automatic')
    return { label: tI18nComplete.raw('textd461a493a375'), selectedProvider: null };
  const selected = selectedProvider ? sandboxProviderLabel(selectedProvider) : null;
  return {
    label: tI18nComplete.raw('text3b3c31642567'),
    selectedProvider: selected,
  };
}

export function describeProviderCoverage(
  status: ProviderCoverageStatus,
  tI18nComplete: UiTranslator,
): {
  label: string;
  tone: 'ok' | 'busy' | 'fail' | 'idle';
} {
  switch (status) {
    case 'ready':
      return { label: tI18nComplete.raw('text5fa7aac5375c'), tone: 'ok' };
    case 'building':
      return { label: tI18nComplete.raw('text87c5912f2cef'), tone: 'busy' };
    case 'failed':
      return { label: tI18nComplete.raw('text031a8f0f659d'), tone: 'fail' };
    case 'not_built':
      return { label: tI18nComplete.raw('text330010f40240'), tone: 'idle' };
    case 'unavailable':
      return { label: tI18nComplete.raw('textca1844969742'), tone: 'idle' };
    case 'unknown':
      return { label: tI18nComplete.raw('textb764cdc0eab7'), tone: 'idle' };
  }
}

export interface SandboxProviderBadgeCopy {
  states?: Partial<Record<ProviderCoverageStatus, string>>;
  selected?: string;
  selectedAria?: string;
}

export function availableProviderCoverage(
  coverage: SandboxTemplate['provider_coverage'] | null | undefined,
): ProviderCoverageEntry[] {
  return (coverage ?? []).filter((item) => item.available);
}

function providerCoverageVariant(
  tone: ReturnType<typeof describeProviderCoverage>['tone'],
): 'success' | 'warning' | 'destructive' | 'muted' {
  if (tone === 'ok') return 'success';
  if (tone === 'busy') return 'warning';
  if (tone === 'fail') return 'destructive';
  return 'muted';
}

/**
 * The freshest observation across every routable provider, or `null` when
 * nothing reported one. Pulled out of the old combined row so the caller can
 * position the "Checked …" stamp itself — in the template card it is pushed to
 * the far edge of the footer, which a pre-composed row could never allow.
 */
export function latestObservedAt(
  coverage: SandboxTemplate['provider_coverage'] | null | undefined,
): string | null {
  return (
    availableProviderCoverage(coverage)
      .map((item) => item.observed_at)
      .filter((value): value is string => !!value)
      .sort()
      .at(-1) ?? null
  );
}

/**
 * One provider's launch readiness. **This is a single badge, not a row.**
 *
 * It replaces `SandboxTemplateProviderCoverage`, which baked its own
 * "Session runtime" label, its badge list and its "Checked …" stamp into one
 * `flex` block. That composite could only ever be dropped into a layout whole,
 * so `sandbox-tab.tsx` ended up nesting a labelled row inside another labelled
 * row — two labels and an un-positionable timestamp in a single wrapping
 * footer. Owning just the badge lets the caller build the row.
 *
 * `SandboxTemplateProviderModeBadge` is gone with it: routing mode is static
 * configuration, not live status, so the card states it as a labelled fact in
 * the spec grid (`describeProviderMode` still supplies the words) rather than
 * floating a bare badge in the runtime strip.
 */
export function SandboxProviderBadge({
  item,
  selected = false,
  copy = {},
}: {
  item: ProviderCoverageEntry;
  /** Pinned mode only — marks the provider sessions actually route to. */
  selected?: boolean;
  copy?: SandboxProviderBadgeCopy;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const state = describeProviderCoverage(item.status, tI18nComplete);
  const stateLabel = copy.states?.[item.status] ?? state.label;
  const provider = sandboxProviderLabel(item.provider);

  return (
    <Badge
      variant={providerCoverageVariant(state.tone)}
      size="xs"
      aria-label={`${provider}${selected ? ` ${copy.selectedAria ?? 'selected'}` : ''}: ${stateLabel}`}
    >
      {provider}
      {selected ? (
        <>
          <span className="opacity-50" aria-hidden="true">
            {tI18nComplete.raw('text3b9453dad42b')}
          </span>
          {copy.selected ?? 'Selected'}
        </>
      ) : null}
      <span className="opacity-50" aria-hidden="true">
        {tI18nComplete.raw('text3b9453dad42b')}
      </span>
      {stateLabel}
    </Badge>
  );
}
