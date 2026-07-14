import type { HarnessAuthKind } from '@kortix/sdk';

/** Connection kinds whose model list is owned by the authenticated harness
 *  itself — never an empty "Available models" group, always the "Models
 *  managed by <Harness>" teaching copy (handoff §5.1). Kept minimal per the
 *  2026-07-14 selector redesign: default option + this note + an optional
 *  custom-ID input is the whole popover for these harnesses. */
const SUBSCRIPTION_KINDS = new Set<HarnessAuthKind>(['claude_subscription', 'codex_subscription']);

export function isSubscriptionConnection(kind: HarnessAuthKind | null | undefined): boolean {
  return !!kind && SUBSCRIPTION_KINDS.has(kind);
}

/**
 * When the resolved connection is a subscription and the harness exposes no
 * presets (its catalog is owned by the authenticated runtime, never
 * fabricated from models.dev), the "Available models" group is replaced by
 * this teaching copy instead of being silently omitted. `null` otherwise —
 * callers fall through to their normal empty state.
 */
export function harnessSubscriptionCopy(input: {
  connectionKind: HarnessAuthKind | null | undefined;
  harnessLabel: string;
  connectionLabel?: string | null;
}): { title: string; subtitle: string } | null {
  if (!input.connectionKind || !SUBSCRIPTION_KINDS.has(input.connectionKind)) return null;
  return {
    title: `Models managed by ${input.harnessLabel}`,
    subtitle: `via ${input.connectionLabel || input.harnessLabel}`,
  };
}

/**
 * The popover's one-line context header — "what will this agent run on",
 * answered as a resolved connection in plain words. `null` when there is no
 * connection to describe yet (nothing resolved) or when the harness-owned
 * note already says it (subscriptions — see {@link harnessSubscriptionCopy}).
 */
export function connectionContextLine(input: {
  connectionKind: HarnessAuthKind | null | undefined;
  connectionLabel?: string | null;
}): string | null {
  const { connectionKind, connectionLabel } = input;
  if (!connectionKind || isSubscriptionConnection(connectionKind)) return null;
  switch (connectionKind) {
    case 'managed_gateway':
      return 'via Kortix (included)';
    case 'anthropic_api_key':
      return 'via your Anthropic key';
    case 'openai_api_key':
      return 'via your OpenAI key';
    case 'openai_compatible':
    case 'anthropic_compatible':
      return `via ${connectionLabel || 'your custom endpoint'}`;
    case 'native_config':
      return null;
    default:
      return connectionLabel ? `via ${connectionLabel}` : null;
  }
}

/** Human group label for the "models this agent can actually use" list —
 *  grouped by connection, never a raw connection id. */
export function connectionGroupLabel(input: {
  connectionKind: HarnessAuthKind | null | undefined;
  connectionLabel?: string | null;
}): string {
  const { connectionKind, connectionLabel } = input;
  switch (connectionKind) {
    case 'managed_gateway':
      return 'Kortix — included';
    case 'anthropic_api_key':
      return 'Your Anthropic key';
    case 'openai_api_key':
      return 'Your OpenAI key';
    case 'openai_compatible':
    case 'anthropic_compatible':
      return connectionLabel || 'Custom endpoint';
    default:
      return connectionLabel || 'Available models';
  }
}

/** Copy for the recommended-default row pinned first, always with a check
 *  when it's the active choice — never a switch that can be "off" while
 *  still selected. */
export function defaultOptionCopy(input: {
  connectionKind: HarnessAuthKind | null | undefined;
  harnessLabel: string;
}): { label: string; subtitle: string } {
  const { connectionKind, harnessLabel } = input;
  if (connectionKind === 'managed_gateway') {
    return { label: 'Automatic', subtitle: 'Kortix picks the best model' };
  }
  return { label: 'Harness default', subtitle: `${harnessLabel} decides` };
}

/** A search field only earns its place once the usable list is long enough
 *  to need one (handoff-style "hide the catalog until asked"). */
export function shouldShowModelSearch(count: number): boolean {
  return count > 8;
}
