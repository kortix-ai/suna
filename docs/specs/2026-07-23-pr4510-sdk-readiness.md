# PR 4510 SDK readiness

## Scope

This slice closes three verified gaps without changing existing public names.

1. `SessionHandle.ensureReady()` waits through retriable boot stages.
2. The SDK reports each observed boot payload through an optional callback.
3. The SDK session create and response types include the existing KaaB fields.

The web boot surface must use the server `reason` field. It must not invent a
runtime substage from elapsed time.

## Compatibility

- Existing `ensureReady()` calls remain valid.
- Existing session create payloads remain valid.
- `origin_ref` is optional and requires backend-origin authentication.
- `origin` and `origin_ref` are additive response fields.
- No exported name is removed or renamed.

## Out of scope

- Merging PR `#4510` into `main`.
- Infrastructure changes that reduce provider boot time.
- Replacing the imperative ACP facade with `AcpSession`.
- Changing Git credential authorization.

## Acceptance criteria

- A provisioning response followed by a starting response and a ready response
  resolves one `ensureReady()` call.
- `onProgress` receives all three responses in order.
- A terminal response still rejects immediately.
- The KaaB fields round-trip through the typed SDK request and response surface.
- The web boot checklist maps server reasons to visible steps.
- The focused tests and the complete SDK gates pass.
