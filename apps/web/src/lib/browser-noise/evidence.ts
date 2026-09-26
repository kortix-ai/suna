// One normalized view of a captured browser error, built from either capture
// path, so every noise rule reads the same fields:
//   - the runtime gate (`window.onerror` / `unhandledrejection` / error
//     boundaries) sees a message, the `onerror` filename, and the raw thrown
//     or rejected values;
//   - the Sentry `beforeSend` gate sees a Sentry event: the primary exception's
//     value, stack frames (oldest first), mechanism, `extra`, request URL, and
//     environment.
// A field the capture path does not carry is empty (`''`, `[]`) or undefined,
// which every predicate treats the same as "absent".

export type NoiseKind = 'runtime' | 'sentry';

export interface NoiseFrame {
  filename?: unknown;
  function?: unknown;
}

export interface NoiseEvidence {
  message: unknown;
  /** `window.onerror` filename. Runtime captures only. */
  filename: unknown;
  /** Primary exception stack frames, oldest first. Sentry captures only. */
  frames: NoiseFrame[];
  mechanism: unknown;
  handled: unknown;
  extra: unknown;
  requestUrl: string;
  environment: string;
  /** Raw `error` / rejection `reason` values. Runtime captures only. */
  error: unknown;
  reason: unknown;
  digest: unknown;
}

export interface NoiseRule {
  /** Stable kebab-case name of the noise class. */
  id: string;
  /** Which gate consults the rule. */
  appliesTo: NoiseKind | 'both';
  match(evidence: NoiseEvidence): boolean;
}

export interface RuntimeNoiseInput {
  message?: unknown;
  filename?: unknown;
  error?: unknown;
  reason?: unknown;
}

export interface SentryNoiseEvent {
  message?: unknown;
  extra?: unknown;
  environment?: unknown;
  request?: { url?: unknown };
  exception?: {
    values?: Array<{
      value?: unknown;
      digest?: unknown;
      mechanism?: { type?: unknown; handled?: unknown };
      stacktrace?: { frames?: NoiseFrame[] };
    }>;
  };
}

export function runtimeNoiseEvidence(input: RuntimeNoiseInput): NoiseEvidence {
  return {
    message:
      [input.message, extractMessage(input.error), extractMessage(input.reason)].find((value) =>
        Boolean(value),
      ) ?? '',
    filename: input.filename,
    frames: [],
    mechanism: undefined,
    handled: undefined,
    extra: undefined,
    requestUrl: '',
    environment: '',
    error: input.error,
    reason: input.reason,
    digest: extractDigest(input.error ?? input.reason),
  };
}

export function sentryNoiseEvidence(event: SentryNoiseEvent, hint?: { originalException?: unknown }): NoiseEvidence {
  const primaryException = event.exception?.values?.find(Boolean);
  return {
    message: primaryException?.value ?? event.message,
    filename: undefined,
    frames: primaryException?.stacktrace?.frames ?? [],
    mechanism: primaryException?.mechanism?.type,
    handled: primaryException?.mechanism?.handled,
    extra: event.extra,
    requestUrl: normalizeString(event.request?.url),
    environment: normalizeString(event.environment),
    error: undefined,
    reason: undefined,
    digest: extractDigest(hint?.originalException) || extractDigest(primaryException),
  };
}

function extractDigest(value: unknown): string {
  if (value && typeof value === 'object' && 'digest' in value) {
    return normalizeString((value as { digest?: unknown }).digest);
  }
  return '';
}

/** Every source location of a capture: the `onerror` filename, then each frame's. */
export function sourcesOf(input: {
  filename?: unknown;
  frames?: Array<{ filename?: unknown } | undefined>;
}): unknown[] {
  return [input.filename, ...(input.frames ?? []).map((frame) => frame?.filename)];
}

// A de-minified first-party source frame: Sentry's sourcemap resolution
// rewrote the raw `_next/static/chunks/…` filename back to the original
// `apps/web/src/…` source path (with or without an `app:///` origin prefix).
// A throw from such a frame originates in our own code, so it is actionable.
export function isFirstPartyResolvedSource(filename: unknown): boolean {
  return normalizeString(filename).includes('apps/web/src/');
}

export function containsKnownPattern(message: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => message.includes(pattern));
}

export function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function isBrowserBundleSource(filename: unknown): boolean {
  const normalized = normalizeString(filename);
  return (
    normalized.startsWith('app:///_next/static/') ||
    /^https?:\/\/[^/]+\/_next\/static\//.test(normalized)
  );
}

function extractMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  if (value && typeof value === 'object' && 'message' in value) {
    return normalizeString((value as { message?: unknown }).message);
  }
  return '';
}

// Strip the canonical `SyntaxError: ` / `Error: ` / `Unhandled promise
// rejection: ` (and stacked) wrappers a browser/Sentry prefixes a throw with,
// so the underlying message can be matched by an anchored pattern regardless
// of which capture path delivered it.
export function stripErrorWrappers(message: string): string {
  return message.trim().replace(/^(?:Unhandled promise rejection: )?(?:[A-Za-z]+Error: )?/, '');
}

// A frame/filename that points at a REAL source location: non-empty AND not the
// literal `"undefined"` placeholder the global-onerror capture uses when the
// engine could not produce a stack. A real chunk (`app:///_next/…`), a URL
// (`https://…`), or a de-minified `apps/web/src/…` path all qualify; the
// synthetic `{ filename: 'undefined' }` frame does not.
export function isResolvableFrameSource(filename: unknown): boolean {
  const normalized = normalizeString(filename);
  return normalized !== '' && normalized !== 'undefined';
}
