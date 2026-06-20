# promptAsync Debug: Dashboard File Upload Flow

## Investigation Summary

Exhaustive trace of the entire data path from dashboard send → sessionStorage → session-chat pending prompt → SDK `promptAsync` → server.

## SDK Architecture (v2, @opencode-ai/sdk@1.3.7)

The web app imports from `@opencode-ai/sdk/v2/client` (NOT v1). Key differences:

### v2 SDK Parameter Handling
- v2 methods take `(parameters, options)` — a flat params object as first arg
- `buildClientParams()` maps flat keys to `{ path, body, query }` using a config array
- For `promptAsync`, the mapping is:
  ```
  sessionID → path.sessionID  (replaces {sessionID} in URL)
  parts     → body.parts
  agent     → body.agent
  model     → body.model
  variant   → body.variant
  directory → query.directory
  workspace → query.workspace
  ```
- URL template: `POST /session/{sessionID}/prompt_async`
- Returns `204 No Content` on success → SDK returns `{ data: {}, request, response }`

### Types Confirmed Valid
- `FilePartInput = { id?: string; type: "file"; mime: string; filename?: string; url: string; source?: FilePartSource }`
- `TextPartInput = { id?: string; type: "text"; text: string; ... }`
- `promptAsync` body accepts `parts: Array<TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput>`
- The file parts from dashboard (`{ type: "file", mime, url, filename }`) match `FilePartInput` exactly

### Body Serialization
- `jsonBodySerializer.bodySerializer(body)` → `JSON.stringify(body)`
- Content-Type: `application/json` (set by SDK)
- `authenticatedFetch` preserves all headers including Content-Type when cloning Request

### Request Interceptor
- `rewrite` interceptor only processes GET/HEAD → no effect on POST `promptAsync`
- `authenticatedFetch` injects `Authorization: Bearer <jwt>` header

## Comparison: Pending Prompt Path vs handleSend Path

### What's Identical
1. Same SDK client instance (from `getClient()`)
2. Same `promptAsync` method on `Session2` class
3. Same part types (TextPartInput + FilePartInput)
4. Same `sessionID` path parameter
5. Same `.then()/.catch()` error handling pattern
6. Same `as any` type assertion

### Differences Found (BEFORE fix)

| Aspect | Pending Prompt | handleSend |
|--------|---------------|------------|
| `setStatus("busy")` | **MISSING** | ✅ Called before send |
| Part mapping | Raw `allParts` array | `mappedParts` via `.map()` strip |
| `getClient()` error handling | **None — throws kill effect** | N/A (in async callback) |
| Spread syntax for options | `&&` pattern | `? :` ternary pattern |
| Logging detail | Minimal | N/A (same) |

### Critical Finding: Missing Busy Status
The pending prompt path did NOT call `useSyncStore.getState().setStatus(sessionId, { type: "busy" })`. While this doesn't prevent the HTTP request from reaching the server, it means:
- The session status stays "idle" in the UI
- The polling/recovery logic that watches for idle→busy transitions doesn't engage
- If SSE drops a message, the "stale watchdog" won't detect the stuck state

### Critical Finding: getClient() Can Throw
`getClient()` throws if `getActiveOpenCodeUrl()` returns null (server URL not resolved). In the pending prompt useEffect, this throw:
1. Exits `attemptSend()` silently (no try-catch)
2. Leaves `pendingPromptHandled.current = true` → prompt won't retry
3. Leaves sessionStorage items already removed → prompt is permanently lost
4. Leaves `pendingSendInFlight = true` → UI stays stuck

### Regarding Part Structure
Both paths produce functionally identical payloads. The `mappedParts` transformation in handleSend strips the `id` field from the text part — the pending prompt path's parts already have no `id` field. However, using the same mapping ensures absolute parity.

## Fix Applied

File: `apps/web/src/components/session/session-chat.tsx` (pending prompt useEffect, ~line 3194+)

Changes:
1. **Added `setStatus("busy")`** before sending — matches handleSend behavior
2. **Added `mappedParts` transformation** — identical to handleSend's `.map()` strip
3. **Added try-catch around `getClient()`** — if server URL isn't ready, restores sessionStorage and resets `pendingPromptHandled.current` so a future mount can retry
4. **Enhanced logging** — logs part count, types, and option flags to aid future debugging
5. **Matched spread syntax** — changed `&&` to `? : {}` ternary for exact parity with handleSend

## TypeScript Verification
`npx tsc --noEmit` passes for session-chat.tsx (no new errors introduced).

## Open Questions
- The code analysis shows both paths produce identical HTTP requests. If the server still silently drops the message after these fixes, the issue may be server-side (e.g., OpenCode server race condition when processing `prompt_async` on a brand-new session that hasn't fully initialized).
- Adding browser DevTools network inspection during the dashboard file upload flow would definitively confirm whether the HTTP 204 is received or an error occurs.
