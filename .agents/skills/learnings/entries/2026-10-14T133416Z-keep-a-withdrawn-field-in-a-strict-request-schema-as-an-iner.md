---
recorded: 2026-10-14T13:34:16Z
incident_date: 2026-10-14
---
# Keep a withdrawn field in a strict request schema as an inert, accepted key

**Rule:** When a feature leaves the product, keep each of its request fields in a `.strict()` schema of `@kortix/api-contract` as an optional key marked `@deprecated INERT. Accepted and ignored.` Delete it only in the next SDK major. Add a contract test that the schema still parses the field.

**Trigger surface:** Removing a feature or a request option; editing `SessionCreateInputSchema` or any other `.strict()` request schema in `packages/api-contract/src/index.ts`.

**Incident:** 2026-10-14, near-miss in #9846 (stateless sessions removal), caught on the local stack before the merge. Dropping `persistent_machine` from `SessionCreateInputSchema` made `POST /v1/projects/:id/sessions {"persistent_machine": true}` answer `400 unrecognized_keys`. The published SDK still types the field, so every client that sent it would have failed to create a session. Fixed by keeping the key as inert, like `require_connectors`.

**Enforcement:** `packages/api-contract/src/__tests__/schemas.test.ts` (`SessionCreateInputSchema still accepts the withdrawn persistent_machine field`). Other strict schemas: none yet; the enforcer to build is a test that every SDK request field marked `@deprecated` parses in its strict contract schema.
