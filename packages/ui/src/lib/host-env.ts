/**
 * Deployment values for plain functions in @kortix/ui (error handlers,
 * URL policies), which cannot read React context. Module-level, like
 * `setUiTelemetry`. A host calls `setUiHostEnv` once at module load with a
 * reader; the reader runs on every `uiHostEnv()` call, so it may read
 * config that loads after module evaluation (a runtime config script).
 */
export interface UiHostEnv {
  /** Billing is on, so a 402 opens the upgrade dialog. Default: false. */
  billingEnabled: boolean;
  /** The app's public origin. Default: ''. */
  appUrl: string;
  /** The API base URL, `/v1` included. May be root-relative. Default: ''. */
  backendUrl: string;
  /** Genui map tile style. Unset: OpenFreeMap. `'off'`: no map, only the place rows. */
  mapStyleUrl?: string;
  /** Dark tile style. Unset: `mapStyleUrl`. */
  mapStyleUrlDark?: string;
}

export const defaultUiHostEnv: UiHostEnv = { billingEnabled: false, appUrl: '', backendUrl: '' };

let read: () => Partial<UiHostEnv> = () => ({});

/** Replaces the reader. Omitted fields keep their default. */
export function setUiHostEnv(reader: () => Partial<UiHostEnv>): void {
  read = reader;
}

export function uiHostEnv(): UiHostEnv {
  return { ...defaultUiHostEnv, ...read() };
}
