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

/**
 * Per-request override hook, registered ONLY by `@kortix/sdk/server`'s
 * Node-only `AsyncLocalStorage` layer (`config-node.ts`) — see `runWithKortix`/
 * `createScopedKortix` there. A browser bundle never imports that subpath, so
 * this stays `null` for it and `platformConfig()` behaves exactly as before
 * (reads the process-global `current`). Not part of the public API — do not
 * call `__setConfigResolver` directly; use `runWithKortix`/`createScopedKortix`.
 */
let configResolver: (() => KortixPlatformConfig | undefined) | null = null;

/** @internal Registration seam for `@kortix/sdk/server`. Not for host use. */
export function __setConfigResolver(fn: (() => KortixPlatformConfig | undefined) | null): void {
  configResolver = fn;
}

/** @internal Test-only introspection, so a test file that flips the resolver
 *  (e.g. to exercise the no-resolver fallback path) can snapshot + restore
 *  whatever was registered before it, instead of clobbering a resolver another
 *  test file registered in the same process (bun runs all `src/**\/*.test.ts`
 *  files in one process, sharing this module's state). */
export function __getConfigResolver(): (() => KortixPlatformConfig | undefined) | null {
  return configResolver;
}

/**
 * Wire the platform seam. `current` is a process-wide singleton — safe for a
 * host with exactly one config for its whole lifetime (a browser tab, a CLI,
 * a single-tenant server), but UNSAFE for a server process that must serve
 * concurrent requests carrying different tokens (see the warning on
 * `ServerTokenOptions` in `projects-client/shared.ts`): the last caller to
 * `configureKortix()`/`createKortix()` wins for every other in-flight request.
 * For that "Kortix as a Backend" shape, use `runWithKortix`/`createScopedKortix`
 * from `@kortix/sdk/server` instead — they isolate each call's config in a
 * Node `AsyncLocalStorage` context instead of this shared global.
 *
 * `opts.global === false` (used internally by `createScopedKortix`) skips the
 * global write entirely, so a scoped client never touches/clobbers `current`.
 */
export function configureKortix(config: KortixPlatformConfig, opts?: { global?: boolean }): void {
  if (opts?.global === false) return;
  current = config;
}

/**
 * The platform config in effect for THIS call: an active `runWithKortix`/
 * `createScopedKortix` scope if one is on the current async context, else the
 * process-global `current` set by `configureKortix()`, else the inert default.
 */
export function platformConfig(): KortixPlatformConfig {
  return configResolver?.() ?? current ?? DEFAULT;
}

export function isConfigured(): boolean {
  return current !== null || configResolver?.() !== undefined;
}
