import type { ProviderName } from './index';

export interface ProviderComputeRateCard {
  cpuPerCoreSecond: number;
  memoryPerGbSecond: number;
  diskPerGbSecond: number;
}

// Per-second customer pricing for the reserved sandbox spec in kortix.yaml:
// Platinum's list rates, at 1× (no markup), on every provider.
//   vCPU  $0.0324 / core-hour        → 0.000009          per core-second
//   RAM   $0.0108 / GB-hour          → 0.000003          per GB-second
//   disk  $0.0526 / GB-month (730 h) → 0.0526/730/3600   per GB-second
// The full reserved spec is billed; there is no free allowance.
const HOURS_PER_MONTH = 730;
const CUSTOMER_COMPUTE_RATE_CARD: ProviderComputeRateCard = {
  cpuPerCoreSecond: 0.0324 / 3600,
  memoryPerGbSecond: 0.0108 / 3600,
  diskPerGbSecond: 0.0526 / HOURS_PER_MONTH / 3600,
};

// Keep every provider explicit: adding a provider must also select its customer rate.
const PROVIDER_COMPUTE_RATE_CARDS: Record<ProviderName, ProviderComputeRateCard> = {
  platinum: CUSTOMER_COMPUTE_RATE_CARD,
  daytona: CUSTOMER_COMPUTE_RATE_CARD,
};

/** A legacy `e2b` compute window (E2B support is discontinued) closes at the same rate. */
export function getProviderComputeRateCard(name: string): ProviderComputeRateCard {
  return PROVIDER_COMPUTE_RATE_CARDS[name as ProviderName] ?? CUSTOMER_COMPUTE_RATE_CARD;
}

/**
 * Platinum's list prices in µ$, as Platinum's own config sets them
 * (platinum apps/api/src/config.ts `BILLING_POLICY`): the source the customer
 * rates below are derived from. Change them when Platinum changes its prices.
 */
export const PLATINUM_LIST_PRICE_MICROS = {
  cpuCoreSecond: 9, // pricing.cpu_second_micros
  ramGibSecond: 3, // pricing.ram_gib_second_micros
  volumeGibHour: 82, // billing.volume_gib_hour_micros: unique compressed bytes of a v1 volume
  volumeSnapshotGibHour: 55, // billing.volume_snapshot_gib_hour_micros: legacy volume snapshots
  scratchGibHour: 36, // pricing.scratch_gb_hour_micros: a box's scratch disk, allocated bytes
  workerStorageGibHour: 82, // billing.volume_gib_hour_micros: a Worker's object-storage folder (Platinum charges it $0 until announced)
  diskGbHour: 72, // pricing.storage_gb_hour_micros: a box's disk_gb while running, stopping or stopped
  archivedDiskGbHour: 36, // pricing.archived_storage_gb_hour_micros: an archived box's disk_gb
} as const;

/**
 * What Kortix charges over Platinum's list price. Compute is billed at 1×:
 * CUSTOMER_COMPUTE_RATE_CARD equals PLATINUM_LIST_PRICE_MICROS for vCPU and
 * RAM (compute-rates.test.ts pins it). Storage uses the same ratio.
 */
export const PLATINUM_MARKUP = 1;

/**
 * The storage meters Kortix records: Platinum's volume meter (`resource_kind`
 * of GET /v1/billing/volume-usage, `size_class` of a `volume.storage` event)
 * and the disk of a box that is not running (box-disk-charges.ts): `box_disk`
 * while it is stopped, `box_disk_archived` while it is archived.
 */
export type StorageResourceKind =
  | 'volume'
  | 'volume_snapshot'
  | 'scratch'
  | 'worker_storage'
  | 'box_disk'
  | 'box_disk_archived';

/**
 * Customer storage rates in USD per GiB-hour: Platinum's list price × PLATINUM_MARKUP.
 *   volume             $0.000082 / GiB-hour (≈ $0.0599 / GiB-month of 730 h)
 *   volume_snapshot    $0.000055 / GiB-hour
 *   scratch            $0.000036 / GiB-hour
 *   worker_storage     $0.000082 / GiB-hour (Kortix's own Workers: recorded, never charged)
 *   box_disk           $0.000072 / GB-hour of disk_gb (≈ $0.0526 / GB-month, the running disk rate)
 *   box_disk_archived  $0.000036 / GB-hour of disk_gb
 * Billed from the first GiB-hour on every plan; there is no free allowance.
 */
export const STORAGE_RATES_USD_PER_GIB_HOUR: Record<StorageResourceKind, number> = {
  volume: (PLATINUM_LIST_PRICE_MICROS.volumeGibHour * PLATINUM_MARKUP) / 1_000_000,
  volume_snapshot: (PLATINUM_LIST_PRICE_MICROS.volumeSnapshotGibHour * PLATINUM_MARKUP) / 1_000_000,
  scratch: (PLATINUM_LIST_PRICE_MICROS.scratchGibHour * PLATINUM_MARKUP) / 1_000_000,
  worker_storage: (PLATINUM_LIST_PRICE_MICROS.workerStorageGibHour * PLATINUM_MARKUP) / 1_000_000,
  box_disk: (PLATINUM_LIST_PRICE_MICROS.diskGbHour * PLATINUM_MARKUP) / 1_000_000,
  box_disk_archived: (PLATINUM_LIST_PRICE_MICROS.archivedDiskGbHour * PLATINUM_MARKUP) / 1_000_000,
};
