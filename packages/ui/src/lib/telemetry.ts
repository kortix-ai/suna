/**
 * Telemetry sink for @kortix/ui. Module-level, not context: plain functions
 * (click handlers, store actions) report too. A host calls `setUiTelemetry`
 * once at module load. Defaults: `track`, `captureMessage` and
 * `addBreadcrumb` do nothing; `captureException` logs to the console.
 * Properties carry kinds, counts and sources only: never a name, path, URL or title.
 */
/**
 * A host narrows the event names `track` accepts by declaration merging:
 *   declare module '@kortix/ui/lib/telemetry' {
 *     interface UiTelemetryRegister { event: 'panel_opened' | 'panel_closed' }
 *   }
 * Without it, any string is accepted.
 */
export interface UiTelemetryRegister {}
export type UiTrackEvent = UiTelemetryRegister extends { event: infer E extends string } ? E : string;

export type UiTrackProperties = Record<string, string | number | boolean>;
export type UiSeverity = 'fatal' | 'error' | 'warning' | 'info' | 'debug';

export interface UiCaptureContext {
  level?: UiSeverity;
  /** Indexed, searchable values: kinds, codes and statuses only. */
  tags?: Record<string, string | undefined>;
  extra?: Record<string, unknown>;
}

export interface UiBreadcrumb {
  category?: string;
  level?: UiSeverity;
  data?: Record<string, unknown>;
}

export interface UiTelemetry {
  track(event: UiTrackEvent, properties?: UiTrackProperties): void;
  captureException(error: unknown, context?: UiCaptureContext): void;
  captureMessage(message: string, context?: UiCaptureContext): void;
  addBreadcrumb(breadcrumb: UiBreadcrumb): void;
}

const defaults: UiTelemetry = {
  track: () => {},
  captureException: (error) => console.error(error),
  captureMessage: () => {},
  addBreadcrumb: () => {},
};

let sink: UiTelemetry = defaults;

/** Replaces the sink. Omitted functions keep their default. */
export function setUiTelemetry(next: Partial<UiTelemetry>): void {
  sink = { ...defaults, ...next };
}

// Each call swallows a sink error: telemetry never takes a feature down with it.
function guarded<A extends unknown[]>(pick: (t: UiTelemetry) => (...args: A) => void) {
  return (...args: A): void => {
    try {
      pick(sink)(...args);
    } catch {}
  };
}

export const track = guarded((t) => t.track);
export const captureException = guarded((t) => t.captureException);
export const captureMessage = guarded((t) => t.captureMessage);
export const addBreadcrumb = guarded((t) => t.addBreadcrumb);
