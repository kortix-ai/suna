import { PPWARM_PREFIX, SCOPED_PPWARM_PREFIX } from '../src/snapshots/quota-gc-select';

/**
 * Complete names of the two RETIRED per-project warm image formats. The baker is
 * gone; these names only ever appear now in persisted boot telemetry, which this
 * report classifies after the fact. Kept here (not in the deleted namer) because
 * this is the last consumer.
 */
const EXACT_PPWARM_IMAGE_NAME =
  /^(?:kortix-ppwarm-(?:[0-9a-f]{8}-[0-9a-f]{12}|[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{12})|kpp2-[0-9a-f]{12}-[0-9a-f]{12}-[0-9a-f]{16}-[0-9a-f]{16})$/;

function isExactPpwarmImageName(name: string): boolean {
  return EXACT_PPWARM_IMAGE_NAME.test(name);
}

export type BootImageKind =
  | 'ppwarm'
  | 'default-cold'
  | 'per-project-tpl'
  | 'unknown';

export type TelemetryImageKind =
  | 'warm-hit'
  | 'cold-shared-default'
  | 'cold-per-project-template'
  | 'unknown'
  | 'other';

export interface TelemetryImageRefRow {
  provider: string;
  image_ref: string | null;
  n: number;
}

export interface TelemetryImageRow {
  provider: string;
  image_kind: TelemetryImageKind;
  n: number;
}

/**
 * Historical project images used prefix-only recognition. Keep that behavior
 * for persisted telemetry. Scoped project images use a new namespace and must
 * match its complete shape so an unrelated `kpp2-` value is never counted.
 */
export function classifyBootImage(ref: string | null): BootImageKind {
  if (!ref) return 'unknown';
  if (ref.startsWith(PPWARM_PREFIX)) return 'ppwarm';
  if (ref.startsWith(SCOPED_PPWARM_PREFIX) && isExactPpwarmImageName(ref)) {
    return 'ppwarm';
  }
  if (ref.startsWith('kortix-default-')) return 'default-cold';
  if (ref.startsWith('kortix-tpl-')) return 'per-project-tpl';
  return 'unknown';
}

export function classifyTelemetryImage(ref: string | null): TelemetryImageKind {
  if (ref === null) return 'unknown';
  switch (classifyBootImage(ref)) {
    case 'ppwarm':
      return 'warm-hit';
    case 'default-cold':
      return 'cold-shared-default';
    case 'per-project-tpl':
      return 'cold-per-project-template';
    default:
      return 'other';
  }
}

export function aggregateTelemetryImages(
  rows: readonly TelemetryImageRefRow[],
): TelemetryImageRow[] {
  const counts = new Map<string, TelemetryImageRow>();
  for (const row of rows) {
    const imageKind = classifyTelemetryImage(row.image_ref);
    const key = `${row.provider}\u0000${imageKind}`;
    const current = counts.get(key);
    if (current) {
      current.n += row.n;
      continue;
    }
    counts.set(key, { provider: row.provider, image_kind: imageKind, n: row.n });
  }
  return [...counts.values()].sort(
    (a, b) => a.provider.localeCompare(b.provider) || b.n - a.n,
  );
}
