---
recorded: 2026-08-17T03:19:49Z
incident_date: 2026-08-17
commit: 97fa3aef20
---
# Presigned uploads must suppress runtime-inferred content types

**When:** sending a body to a provider-generated signed upload URL. Send the exact signed headers. Set an explicit empty `Content-Type` when the signature omits it. Do not let Bun infer a MIME type from `Bun.file()`.
*Incident:* E2B template uploads returned GCS `403 SignatureDoesNotMatch` because Bun added `application/gzip` to a URL signed with an empty content type. Template creation succeeded, but every new immutable image remained unbuildable.
*Enforcer:* `unit-e2b-bun-upload-patch.test.ts` requires the E2B dependency patch to use `Bun.file()` and an explicit empty `Content-Type` in both bundles. A real E2B template build verifies the signed upload.
