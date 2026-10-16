/**
 * Daytona sandbox state-transition conflict classification.
 *
 * Daytona answers HTTP 409 `DaytonaConflictError` when a sandbox state
 * transition is already in flight — e.g. a second stop request arrives while
 * the first stop is still settling ("Sandbox state change in progress").
 * `apps/api/src/apps/hosting.ts`'s `stop()` waits through its settle window,
 * then re-throws a plain `Error` whose `cause` is the original
 * `DaytonaConflictError`. Any call site without its own try/catch (the
 * `POST /v1/projects/:id/apps/:appId/stop` route, which unlike its sibling
 * start branch had no error handling) forwarded that error to `app.onError`
 * → generic `500 Internal server error` → Sentry → Better Stack — twice per
 * user click, for a state that was already doing exactly what the user asked.
 * That is Better Stack pattern `6bc03d7d…` (frontend `ApiError: Internal
 * server error`, fed by the API's 500 on the stop route).
 *
 * An in-flight transition is an EXPECTED, self-resolving state — it is
 * already doing what the caller asked — so it must NOT page Sentry. The
 * global ladder (`http-errors.ts`) answers a typed
 * 409 `sandbox_state_change_in_progress`; the SDK's `isExpectedResponse`
 * classifies that code SILENT to `onError` (the same machine as
 * `provision_in_flight` / `model_not_servable`), so the web toast shows the
 * retryable message instead of paging Better Stack.
 *
 * The classifier is deliberately conservative — BOTH signals must be present
 * somewhere on the error (or its `cause`) chain:
 *   1. the Daytona SDK's exact conflict message ("Sandbox state change in
 *      progress"), AND
 *   2. a Daytona conflict shape — the `DaytonaConflictError` class name or a
 *      409 `statusCode`.
 * A bare 409 from an unrelated upstream without that message, or a
 * `DaytonaConflictError` for a different reason (a genuine concurrent
 * mutation conflict), still falls through to the generic capture and stays
 * loud. The sibling transient classes (gateway 502/503/504, connection,
 * timeout) live in `shared/daytona-transient.ts`.
 */

const DAYTONA_STATE_CHANGE_MESSAGE = 'Sandbox state change in progress';

/**
 * Stable error code the platform API returns (HTTP 409) when the sandbox a
 * call targets is already mid state-transition — the Daytona API answered
 * 409 `Sandbox state change in progress`. Emitted by the global error ladder
 * (`apps/api/src/http-errors.ts`) for every unguarded provider call site.
 * EXPECTED and retryable: the in-flight transition resolves on its own, so
 * the client (or the user's second click) can simply try again. Must stay in
 * sync with `packages/sdk/src/core/http/api-client.ts`'s
 * `SANDBOX_STATE_CHANGE_IN_PROGRESS_CODE`, which classifies it silent to
 * `onError`. Mirrors `PROVISION_IN_FLIGHT_CODE` / `MODEL_NOT_SERVABLE_CODE`.
 */
export const SANDBOX_STATE_CHANGE_IN_PROGRESS_CODE = 'sandbox_state_change_in_progress';

/**
 * True when `err` is a Daytona sandbox state-transition conflict: the
 * "Sandbox state change in progress" message AND a Daytona conflict shape
 * (`DaytonaConflictError` name or 409 status) somewhere on the error/cause
 * chain. Pure / synchronous — safe on the `app.onError` hot path, no SDK
 * import needed (name-based detection covers module duplication).
 */
export function isDaytonaStateTransitionConflict(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  let hasConflictMessage = false;
  let hasConflictShape = false;
  for (let e: Error | undefined = err; e; e = e.cause instanceof Error ? e.cause : undefined) {
    if (e.message.includes(DAYTONA_STATE_CHANGE_MESSAGE)) hasConflictMessage = true;
    const status = (e as { statusCode?: unknown }).statusCode;
    if (e.name === 'DaytonaConflictError' || status === 409) hasConflictShape = true;
  }
  return hasConflictMessage && hasConflictShape;
}
