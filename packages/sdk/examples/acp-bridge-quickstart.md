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

## `AcpSession` (the store) does **not** work against the bare bridge today

`AcpSession` — `@kortix/sdk/acp`'s higher-level store (`chatItems`,
`pendingPrompts`, `turnState`, snapshot subscriptions) — is built for a
**platform-API-fronted** ACP endpoint
(`${backendUrl}/projects/{projectId}/sessions/{sessionId}/acp`), not the bare
sandbox daemon shown above. Two concrete, proven gaps, both documented in the
DISC-06 report:

1. `AcpSessionOptions` has no `agent` field — unlike `AcpClient`'s
   `baseUrl`+`serverId`+`agent` mode, `AcpSession` cannot create a brand-new
   bridge server on its own (the bridge requires `?agent=` on the very first
   POST to an unknown `serverId`).
2. `AcpSession.connect()`'s bootstrap unconditionally calls
   `client.transcript()` (`GET {endpoint}/transcript`) as its first step,
   before `initialize`. The bare sandbox daemon bridge has no `/transcript`
   route — that REST leg, and the database-backed envelope history behind
   it, is implemented only by the platform API's ACP proxy in front of the
   bridge. Pointed directly at the bridge, `AcpSession.connect()` fails fast
   and cleanly (`connection: 'failed'`, a terminal `kind: 'bootstrap'`
   error) — it never hangs, but it never completes a turn either.

**Use `AcpClient` directly** (as above) when talking to a bare sandbox
daemon bridge. Use `AcpSession` only against an endpoint that also serves
`/transcript` — in practice, the platform API's session-scoped ACP proxy,
which is what `createKortix(...).session(...)` already resolves for you.
