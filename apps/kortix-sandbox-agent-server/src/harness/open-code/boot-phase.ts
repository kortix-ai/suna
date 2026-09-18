/**
 * One short label for "how far along is this boot" — the value of the
 * `X-Kortix-Boot-Phase` header on every not-ready (503) answer the proxy gives
 * while OpenCode is not serving yet.
 *
 * Why the API needs it: its `/start` budget used to be "not ready for 90 s
 * after the first poll → runtime_boot_failed → pause the box". A resume that
 * has to converge a new OpenCode pin and then sit through that version's first
 * init blows straight through 90 s while doing exactly what it should
 * (Essentia 2026-08-25 17:23–17:24, both boxes). With this label the API can
 * restart its clock whenever the phase CHANGES and only give up when the box
 * has made no progress at all — a stub launcher that respawns forever never
 * changes phase, so the failure it was meant to catch is still caught.
 *
 * The label is opaque to the API: equality is the only operation on it.
 */
export interface BootPhaseInput {
  timeline: ReadonlyArray<{ label: string }>;
  opencodeState: string;
  runtimeAssetsActivity?: string | null;
  notReadyReason?: string;
}

export function bootPhaseLabel(input: BootPhaseInput): string {
  const lastMark = input.timeline.at(-1)?.label ?? 'boot';
  const parts = [lastMark, `opencode=${input.opencodeState}`];
  if (input.runtimeAssetsActivity) parts.push(input.runtimeAssetsActivity);
  if (input.notReadyReason) parts.push(input.notReadyReason);
  return parts.join('|');
}

export const BOOT_PHASE_HEADER = 'X-Kortix-Boot-Phase';
