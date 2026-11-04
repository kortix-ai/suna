---
recorded: 2026-10-23T23:51:01Z
incident_date: 2026-10-23
---
# Require the JSON body before reading validated file-write fields

**Rule:** Set `request.body.required: true` when a JSON route unconditionally reads validated fields.

**Trigger surface:** OpenAPI file-write routes that use `c.req.valid('json')`.

**Incident:** KRTX-3424 recorded four API errors when the file-write handler read `body.path.startsWith` without a path. Optional JSON-body validation skips the schema when the content type is absent or non-JSON.

**Enforcement:** `project-files-write-authority.test.ts` sends absent, non-JSON, malformed and incomplete bodies through the registered HTTP route and requires 400 with no commit.
