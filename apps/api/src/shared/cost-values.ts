/** Numeric columns come back from postgres as strings; usage hints arrive as numbers. */
export type NumericValue = number | string | null | undefined;
export type TemporalValue = Date | string | null | undefined;

export function numberValue(value: NumericValue): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

export function isoValue(value: TemporalValue): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
