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

/** Copy for the recommended-default row pinned first, always with a check
 *  when it's the active choice — never a switch that can be "off" while
 *  still selected. The row itself is just "Auto"; the subtitle is the hover
 *  card's explanation of who actually picks the model. */
export function defaultOptionCopy(input: {
  connectionKind: HarnessAuthKind | null | undefined;
  harnessLabel: string;
}): { label: string; subtitle: string } {
  const { connectionKind, harnessLabel } = input;
  if (connectionKind === 'managed_gateway') {
    return { label: 'Auto', subtitle: 'Kortix picks the best model for you.' };
  }
  return { label: 'Auto', subtitle: `${harnessLabel} decides which model to run.` };
}

/** A search field only earns its place once the usable list is long enough
 *  to need one (handoff-style "hide the catalog until asked"). */
export function shouldShowModelSearch(count: number): boolean {
  return count > 8;
}

export interface HarnessModelPreset {
  id: string;
  name: string;
  source: string;
}

/**
 * The quiet right-aligned provider tag on a one-line model row. The prefix
 * disambiguates same-named models served by different providers (a real
 * collision in a 150-provider catalog) without a second row of raw-id noise.
 * Managed-gateway ids are namespaced under the synthetic `kortix` provider
 * (`kortix/<real-provider>/<model>`) — the tag looks through that namespace
 * and names the REAL provider, never "kortix" on every single row. `null`
 * for bare harness-native ids (`claude-sonnet-4-6`) and managed-lineup
 * models with no sub-provider, where a tag would just repeat what the
 * picker already says.
 */
export function presetProviderTag(preset: Pick<HarnessModelPreset, 'id'>): string | null {
  const segments = preset.id.split('/');
  const start = segments[0] === 'kortix' ? 1 : 0;
  return (segments.length - start >= 2 && segments[start]) || null;
}

/** The gateway catalog ships a synthetic Auto entry (`kortix/auto`). The
 *  picker pins its own Auto row, so rendering the preset version too reads
 *  as two "Auto"s — {@link filterHarnessPresets} drops it. */
export function isSyntheticAutoPreset(preset: Pick<HarnessModelPreset, 'id'>): boolean {
  return preset.id === 'auto' || preset.id === 'kortix/auto';
}

/**
 * Search-filter a harness preset list and bound how many rows actually
 * render. A gateway-backed harness (Pi/OpenCode on Kortix) can surface the
 * ENTIRE model catalog as presets — thousands of entries — and mounting one
 * `CommandItem` per model froze the popover open/typing path (the "Pi picker
 * lags, Codex doesn't" bug: Codex is subscription-backed and renders zero
 * presets). Search always scans the full list; the cap only limits what
 * mounts, with `hiddenCount` telling the UI how many rows search can still
 * reach. The selected model is always kept visible so its check mark never
 * silently disappears behind the cap.
 */
export function filterHarnessPresets(input: {
  presets: HarnessModelPreset[];
  query: string;
  selectedModel: string | null;
  cap: number;
}): { visible: HarnessModelPreset[]; hiddenCount: number } {
  const q = input.query.trim().toLowerCase();
  const candidates = input.presets.filter((preset) => !isSyntheticAutoPreset(preset));
  const matches = q
    ? candidates.filter(
        (preset) => preset.name.toLowerCase().includes(q) || preset.id.toLowerCase().includes(q),
      )
    : candidates;
  const visible = matches.slice(0, input.cap);
  if (input.selectedModel && !visible.some((preset) => preset.id === input.selectedModel)) {
    const selected = matches.find((preset) => preset.id === input.selectedModel);
    if (selected) visible.push(selected);
  }
  return { visible, hiddenCount: matches.length - visible.length };
}
