/**
 * Per-flag overrides for `@kortix/sdk/feature-flags`. A host that isn't Next.js
 * (no `NEXT_PUBLIC_*` build-time env, e.g. React Native, a bare browser bundle,
 * or a CLI) has no other way to flip these — `configureKortix({ featureFlags })`
 * is the portable seam. Omitted flags fall back to the legacy `NEXT_PUBLIC_*`
 * env var (so web keeps working unchanged), then to the flag's own default. See
 * `feature-flags.ts` for what each flag does.
 */
export interface KortixFeatureFlagOverrides {
  disableMobileAdvertising?: boolean;
  enableDinoGame?: boolean;
  enableProjects?: boolean;
  enableAutoModel?: boolean;
}

/**
 * The single app-specific seam. Everything else in the SDK is portable; this is
 * the one place a host app injects its identity + backend. Web wires its
 * Supabase token here; the demo/CLI wire a PAT. Call `configureKortix()` once at
 * startup before any data-layer call.
 */
export interface KortixPlatformConfig {
  /** Absolute backend base URL incl. version prefix, e.g. `http://localhost:8008/v1`. */
  backendUrl: string;
  /** Returns the current bearer (Supabase JWT, PAT, or API key) — or null if unauthenticated. */
  getToken: () => Promise<string | null>;
  /** Optional UI error sink (toast/log). No-op by default. */
  onError?: (error: unknown, context?: unknown) => void;
  /** Default sandbox id for local/single-sandbox hosts (was `getEnv().SANDBOX_ID`). */
  sandboxId?: string | null;
  /** Whether billing gates are active (was `isBillingEnabled()`). */
  billingEnabled?: boolean;
  /** Current user id, used to scope the offline message cache. */
  getUserId?: () => Promise<string | null>;
  /** Toast sink — the host renders it. */
  onToast?: (level: 'info' | 'success' | 'error' | 'warning', message: string, options?: unknown) => void;
  /** OS/web-notification sink — the host renders it. */
  onNotify?: (event: { kind: string; sessionId: string; [key: string]: unknown }) => void;
  /** Explicit per-flag overrides for `@kortix/sdk/feature-flags` (portable path). */
  featureFlags?: KortixFeatureFlagOverrides;
}

/**
 * Inert default so module-eval / SSR (which touch SDK modules before the host's
 * provider runs) never crash. The host's `configureKortix` overrides it before
 * any real data call — an unauthenticated default just yields no token / no URL.
 */
const DEFAULT: KortixPlatformConfig = {
  backendUrl: '',
  getToken: async () => null,
};

let current: KortixPlatformConfig | null = null;

export function configureKortix(config: KortixPlatformConfig): void {
  current = config;
}

export function platformConfig(): KortixPlatformConfig {
  return current ?? DEFAULT;
}

export function isConfigured(): boolean {
  return current !== null;
}
