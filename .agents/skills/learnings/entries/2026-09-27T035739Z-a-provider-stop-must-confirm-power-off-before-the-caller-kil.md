---
recorded: 2026-09-27T03:57:39Z
incident_date: 2026-09-27
---
# A provider stop() must confirm power-off before the caller kills the token

**Rule:** any `stop()`/`archive()` provider adapter that returns as soon as
the provider ACKs the request, before the resource is actually gone, lets the
control plane mark the DB row stopped (killing its token/lease) while the
resource is still alive and still calling home with a now-dead credential.
Poll for the terminal state (bounded, e.g. 10s) and throw on timeout so the
caller's existing retry/claim-release path runs again — never return
silently on an ACK alone.

**Trigger surface:** writing or reviewing any sandbox/VM provider adapter's
`stop`/`pause`/`archive` method, especially one with an async provider-side
power-off that lags its HTTP ACK.

**Incident:** `PlatinumProvider.stop()` (`apps/api/src/services/sandboxes/platinum/runtime.ts`)
returned right after the stop-request ACK; `start()` already polled to
confirm state for the symmetric reopen race, but `stop()` never did. 76h prod
window: 404,982 `401 Session token is not active` rejections across 95
projects, one VM posting for its full 12h idle timeout after its lease closed.

**Enforcement:** `apps/api/src/services/sandboxes/platinum/runtime-stop-confirm.test.ts`.
