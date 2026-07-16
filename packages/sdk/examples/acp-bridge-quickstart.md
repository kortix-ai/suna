# ACP bridge quickstart — driving a sandbox daemon directly with `@kortix/sdk/acp`

This is the low-level recipe for talking to a Kortix sandbox's ACP daemon
bridge (`apps/kortix-sandbox-agent-server`'s `/acp/:serverId` HTTP+SSE
surface) straight from `AcpClient` — no platform API, no browser. Most
consumers should go through `createKortix(...).session(...)` (see
`02-send-and-stream.ts`), which resolves the bridge URL and auth for you.
Reach for this recipe only when you are talking to the bridge directly, e.g.
from inside the platform API itself, or from a test harness.

Every line below is exactly what
`apps/kortix-sandbox-agent-server/src/__tests__/sdk-bridge.e2e.test.ts`
(DISC-06) proved passing against a **real** bridge (`buildAcpApp` +
`Bun.serve`) and a **real** spawned ACP agent process — nothing here is
aspirational.

```ts
// As a workspace consumer: import { AcpClient } from '@kortix/sdk/acp';
// As an npm consumer:       import { AcpClient } from '@kortix/sdk/acp';
import { AcpClient, type AcpStreamEvent } from '@kortix/sdk/acp';

// The bridge authenticates every /acp/* request with a signed
// `X-Kortix-User-Context` HMAC header, not a bearer token — `getToken()`
// doesn't fit that shape. `AcpClientOptions.fetch` is the documented seam
// for this: pass any `typeof fetch`-compatible function and AcpClient uses
// it for every request instead of its default `authenticatedFetch`.
function createSignedFetch(signedContextHeader: string): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('X-Kortix-User-Context', signedContextHeader);
    return fetch(input, { ...init, headers });
  }) as typeof fetch;
}

async function main() {
  const baseUrl = 'http://127.0.0.1:PORT';       // the sandbox's own HTTP port
  const serverId = 'my-session-id';               // any id you choose — first
                                                    // POST creates the process
  const signedContextHeader = 'PAYLOAD.SIGNATURE'; // minted server-side (HMAC
                                                    // over the sandbox token)

  // baseUrl + serverId + agent = "daemon bridge mode" (as opposed to
  // `endpoint`, used when a platform-API-fronted URL already resolves the
  // harness). `agent` is only required on the FIRST POST to a not-yet-created
  // serverId — the daemon spawns the process on that call.
  const client = new AcpClient({
    baseUrl,
    serverId,
    agent: 'codex', // or 'claude', or any harness id the bridge's registry knows
    fetch: createSignedFetch(signedContextHeader),
  });

  await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const session = await client.newSession({ cwd: '/workspace' });

  // Real streamed updates, over the real SSE connect() path.
  const handle = client.connect({
    onEvent: (event: AcpStreamEvent) => {
      if ('method' in event.envelope && event.envelope.method === 'session/request_permission') {
        // A real harness pauses mid-turn here to ask for a permission
        // decision — answer it with respond(), keyed by the request's id.
        void client.respond(event.envelope.id as string, {
          outcome: { outcome: 'selected', optionId: 'allow_once' },
        });
        return;
      }
      if ('method' in event.envelope && event.envelope.method === 'session/update') {
        console.log('update:', event.envelope.params);
      }
    },
  });

  const result = await client.prompt(session.sessionId, [{ type: 'text', text: 'work' }]);
  console.log('turn finished:', result.stopReason); // 'end_turn' | 'cancelled' | ...

  handle.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

Reconnecting after a dropped connection replays only what you missed:

```ts
let lastEventId = 0;
const handle = client.connect({
  lastEventId,                 // resume after this id — 0 means "from the start"
  onEvent: (event) => { lastEventId = event.id; /* ... */ },
});
```

Cancelling mid-turn is a fire-and-forget notification; the in-flight
`client.prompt()` call resolves once the harness reports the turn as
stopped:

```ts
await client.cancel(session.sessionId); // notifies the harness
// the pending client.prompt(...) promise above resolves with
// { stopReason: 'cancelled' } (or whatever the harness reports)
```

## `AcpSession` (the store) is a platform-endpoint tool, by design — not a bridge-direct one

`AcpClient` (above) is the **daemon-bridge** layer: it speaks directly to a
sandbox's bare `/acp/:serverId` surface and nothing else — no persistence, no
durable history, just the live JSON-RPC/SSE wire. `AcpSession` is a different
layer entirely: the ergonomic store (`chatItems`, `pendingPrompts`,
`turnState`, snapshot subscriptions) that grounds itself in the **durable,
database-backed transcript** the platform API owns. That grounding is the
point — a real host reconnects, resumes across tabs/devices, and replays
history without re-deriving state from a live process alone — and only the
platform API's session-scoped ACP proxy
(`${backendUrl}/projects/{projectId}/sessions/{sessionId}/acp`) can serve it,
because only the platform API persists envelopes to a database. The bare
sandbox daemon bridge is deliberately stateless past the in-memory process
it's fronting; it was never meant to be `AcpSession`'s transport, and adding a
`/transcript` shim to it would just duplicate the platform's durable-storage
job in a second place.

DISC-06 confirmed this by pointing `AcpSession` straight at the bare bridge
and observing, not guessing, the result — two concrete findings, both
consequences of the layering above rather than defects in either layer:

1. `AcpSessionOptions` has no `agent` field — unlike `AcpClient`'s
   `baseUrl`+`serverId`+`agent` mode, `AcpSession` cannot create a brand-new
   bridge server on its own (the bridge requires `?agent=` on the very first
   POST to an unknown `serverId`). Expected: the platform API already knows
   the agent for a session and supplies it when it fronts the bridge, so
   `AcpSession` never needed this parameter for its actual (platform-fronted)
   use case.
2. `AcpSession.connect()`'s bootstrap unconditionally calls
   `client.transcript()` (`GET {endpoint}/transcript`) as its first step,
   before `initialize` — it is grounding itself in the durable transcript
   before it will trust anything live. The bare sandbox daemon bridge has no
   `/transcript` route, and by design: that REST leg, and the
   database-backed envelope history behind it, is implemented only by the
   platform API's ACP proxy in front of the bridge. Pointed directly at the
   bare bridge, `AcpSession.connect()` fails fast and cleanly
   (`connection: 'failed'`, a terminal `kind: 'bootstrap'` error) — it never
   hangs, but it never completes a turn either, because the durable transcript
   it depends on genuinely does not exist at that layer.

**Use `AcpClient` directly** (as above) when talking to a bare sandbox
daemon bridge — e.g. from inside the platform API itself, or a test harness.
**Use `AcpSession`** only against an endpoint that also serves `/transcript`
— in practice, the platform API's session-scoped ACP proxy, which is what
`createKortix(...).session(...)` already resolves for you. Reaching for
`AcpSession` against a bare bridge is a layering mismatch, not a bug to work
around; if your host needs the store's ergonomics, front the bridge with the
platform API rather than trying to make the bridge serve `/transcript`
itself.
