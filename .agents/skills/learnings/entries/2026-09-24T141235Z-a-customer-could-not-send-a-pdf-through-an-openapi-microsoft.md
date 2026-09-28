---
recorded: 2026-09-24T14:12:35Z
incident_date: 2026-09-24
commit: 8bb0008aea
---
# A customer could not send a PDF through an OpenAPI Microsoft Graph connector

**Incident.** A customer's agent sent text email through an OpenAPI
`microsoft-graph` connector but could not attach a PDF. Four defects stacked:
(1) the MCP `attachment_files` path accepted only a top-level `attachments`
property, and Graph nests it at `body.message.attachments`; (2) staged files
resolved only for the native Email channel, never for OpenAPI or HTTP
connectors; (3) `kortix connectors call` read args only from one argv string,
which Linux caps at 128 KiB, so an inline base64 body could not pass; (4) the
request builder double-encoded a `body` passed as a JSON string and emitted two
`Content-Type` headers when a spec declared `content-type` as a header
parameter. Graph answered (4) with "Unable to read JSON request payload.
Please ensure Content-Type header is set", which pointed at the wrong layer.

**Rule.** A request body is encoded exactly once, and exactly one
`Content-Type` header matches the encoding; header merges are
case-insensitive. File bytes never travel in call args or through the model:
stage the file, pass the namespaced reference `{"$kortix_attachment": id}`, and
resolve it server-side from the action schema with exact-key profiles, never
fuzzy field-name guesses. A reference marker must be a key no upstream API
uses — an earlier draft keyed on `attachment_id` and would have hijacked APIs
that use that field themselves.

**Enforcement.** `apps/api/src/connectors/attachment-inline.test.ts` (profiles,
collision regression, redaction), `unit-connector-call.test.ts` (one header,
no double encoding, spec media type), `e2e-connector-faces.test.ts` (real CLI
and MCP processes against a Graph-strict fake upstream, byte-for-byte).
