import type { UiTranslator } from '../../../i18n';
import type { SandboxTemplate } from '@kortix/sdk';
import { useTranslations } from '../../../i18n';

import { Badge } from '../../../primitives/badge';
import {
  formatSandboxProvider,
  isLegacySandboxProvider,
} from '../../../internal/lib/sandbox-providers';

export type ProviderCoverageEntry = NonNullable<SandboxTemplate['provider_coverage']>[number];
export type ProviderCoverageStatus = ProviderCoverageEntry['status'];
export type SandboxProvider = ProviderCoverageEntry['provider'];

export type SandboxProviderMode = 'automatic' | 'pinned';

/** A provider's name, with a `Legacy` badge for the legacy fallback provider (Daytona). */
export function SandboxProviderLabel({ provider }: { provider: string }) {
  const t = useTranslations('settings.sandbox');
  return (
    <span className="inline-flex items-center gap-1.5">
      {formatSandboxProvider(provider)}
      {isLegacySandboxProvider(provider) ? (
        <Badge variant="muted" size="sm">
          {t('provider.legacy')}
        </Badge>
      ) : null}
    </span>
  );
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
}

/** Every sandbox runs on Platinum: a deprecated provider's coverage is not shown. */
export function availableProviderCoverage(
  coverage: SandboxTemplate['provider_coverage'] | null | undefined,
): ProviderCoverageEntry[] {
  return (coverage ?? []).filter(
    (item) => item.available && !isLegacySandboxProvider(item.provider),
  );
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
 * `flex` block. Owning just the badge lets the caller build the row.
 */
export function SandboxProviderBadge({
  item,
  copy = {},
}: {
  item: ProviderCoverageEntry;
  copy?: SandboxProviderBadgeCopy;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const state = describeProviderCoverage(item.status, tI18nComplete);
  const stateLabel = copy.states?.[item.status] ?? state.label;
  const provider = formatSandboxProvider(item.provider);

  return (
    <Badge
      variant={providerCoverageVariant(state.tone)}
      size="xs"
      aria-label={`${provider}: ${stateLabel}`}
    >
      {provider}
      <span className="opacity-50" aria-hidden="true">
        {tI18nComplete.raw('text3b9453dad42b')}
      </span>
      {stateLabel}
    </Badge>
  );
}
