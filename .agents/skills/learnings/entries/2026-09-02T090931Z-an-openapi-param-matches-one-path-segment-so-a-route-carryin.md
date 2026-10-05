---
recorded: 2026-09-02T09:09:31Z
incident_date: 2026-09-02
commit: 5d78e08c77
---
# An OpenAPI `{param}` matches ONE path segment, so a route carrying a file path 404s on every real path

**When:** putting anything slash-bearing into a typed route parameter — a file
path, a ref name, a nested key. `@hono/zod-openapi`'s `{path}` compiles to a
single-segment matcher, so
`/{projectId}/filesystems/{name}/files/{path}` served `plan.md` and 404'd
`notes/2026/plan.md` — which is most real paths. The HANDLER was correct; the
pattern it hung off never matched, so the failure looked like "file not found"
rather than "route not found", and every negative test still passed for the
wrong reason.
**What made it invisible locally:** 32 unit tests were green — the path
normaliser, the blob store against real MinIO, the whole service layer — because
none of them route. A green unit suite says the pieces work; it says nothing
about whether a request can REACH them. The bug surfaced on the first real HTTP
call to the deployed preview, on the third step of nine.
**Rules:** (1) a path-shaped value travels as a QUERY parameter
(`?path=`) unless the router is known to support wildcards — this API already
established that with `/v1/projects/:id/files/content?path=`; (2) every new
route family gets one real request against a deployed origin before it is
called done, and the request must use a REALISTIC value (a nested path, not
`a.txt`); (3) when a route 404s, check whether the pattern matched at all
before debugging the handler.
**Diagnostic:** sibling routes on the same prefix work (`create`, `list`,
`delete` all 2xx) while one family 404s — that asymmetry is a routing shape
problem, not a data problem.
*Near-miss:* caught on the pi-worker preview before reaching main or a user.
*Enforcer:* flows FS-1..FS-4 use `notes/2026/plan.md`, a genuinely nested path,
so a segment-matching regression fails the suite rather than passing on a
flat filename.
