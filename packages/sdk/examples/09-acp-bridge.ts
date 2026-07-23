/**
 * 09 — Driving a sandbox daemon's ACP bridge directly with `AcpClient`.
 *
 * This is the runnable, typechecked counterpart to `acp-bridge-quickstart.md`.
 * It is assembled from the same calls the e2e proof
 * (`apps/kortix-sandbox-agent-server/src/__tests__/sdk-bridge.e2e.test.ts`,
 * DISC-06) exercises against a REAL bridge and a REAL spawned ACP agent
 * process, in the same sequence: construct `AcpClient` in daemon-bridge mode
 * (`baseUrl` + `serverId` + `agent`) with a custom `fetch` that signs every
 * request, `initialize()`, `newSession()`, `connect()` for streamed events,
 * `prompt()`, answer the `session/request_permission` request with
 * `respond()`, and `cancel()`.
 *
 * Most consumers should go through `createKortix(...).session(...)` instead
 * (see `02-send-and-stream.ts`), which resolves the bridge URL and auth for
 * you. Reach for `AcpClient` directly only when talking to a bare sandbox
 * daemon bridge — e.g. from inside the platform API itself, or a test
 * harness — which is why this example's `main()` is gated behind an env var:
 * there is no bridge reachable in the example environment by default.
 *
 * Run (against a real `apps/kortix-sandbox-agent-server` bridge):
 *   ACP_BRIDGE_BASE_URL=http://127.0.0.1:PORT \
 *   ACP_BRIDGE_SERVER_ID=my-session-id \
 *   ACP_BRIDGE_SIGNED_CONTEXT=PAYLOAD.SIGNATURE \
 *     bun run examples/09-acp-bridge.ts
 *
 * As an npm consumer:
 *   import { AcpClient, type AcpStreamEvent } from '@kortix/sdk/acp';
 */
import { AcpClient, type AcpEnvelope, type AcpRequest, type AcpStreamEvent } from '../src/acp/index';

// The bridge authenticates every /acp/* request with a signed
// `X-Kortix-User-Context` HMAC header, not a bearer token — `getToken()`
// doesn't fit that shape. `AcpClientOptions.fetch` is the documented seam for
// exactly this: pass any `typeof fetch`-compatible function and AcpClient
// uses it for every request instead of its default `authenticatedFetch`.
function createSignedFetch(signedContextHeader: string): typeof fetch {
  const signed = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const headers = new Headers(init?.headers);
    headers.set('X-Kortix-User-Context', signedContextHeader);
    return fetch(input, { ...init, headers });
  };
  return signed as unknown as typeof fetch;
}

/**
 * Local narrowing guard, named to match the SDK's own exported
 * `isAcpResponseEnvelope` (`@kortix/sdk/acp`) — not re-exported from the SDK,
 * just this example's equivalent for the request/notification side. A plain
 * `'method' in event.envelope` check narrows only to
 * `AcpRequest | AcpNotification`, which still lacks `.id` under
 * `tsc --strict`; checking for `'id'` too is what actually narrows to
 * `AcpRequest`.
 */
function isAcpRequestEnvelope(envelope: AcpEnvelope): envelope is AcpRequest {
  return 'method' in envelope && 'id' in envelope;
}

/** Polls the in-memory event buffer `onEvent` appended to, the same shape
 *  `sdk-bridge.e2e.test.ts`'s `waitForEvent` helper uses — `connect()`
 *  delivers events via callback, not a readable stream `main()` can `await`
 *  directly. */
function waitForEvent(
  events: readonly AcpStreamEvent[],
  predicate: (event: AcpStreamEvent) => boolean,
  timeoutMs = 5_000,
): Promise<AcpStreamEvent> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const found = events.find(predicate);
      if (found) return resolve(found);
      if (Date.now() > deadline) return reject(new Error('expected ACP stream event did not arrive in time'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function isMethod(envelope: AcpEnvelope, method: string): boolean {
  return 'method' in envelope && envelope.method === method;
}

async function main(baseUrl: string, serverId: string, signedContextHeader: string) {
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

  // Real streamed updates, over the real SSE connect() path. Events are
  // buffered here rather than answered inside `onEvent` — mirroring the
  // e2e proof, which awaits the permission event OUTSIDE the callback and
  // responds with the id it already knows, rather than auto-responding from
  // inside the stream handler.
  const events: AcpStreamEvent[] = [];
  const handle = client.connect({ onEvent: (event) => events.push(event) });

  const promptPromise = client.prompt(session.sessionId, [{ type: 'text', text: 'work' }]);

  const permissionEvent = await waitForEvent(events, (event) => isMethod(event.envelope, 'session/request_permission'));
  if (isAcpRequestEnvelope(permissionEvent.envelope)) {
    await client.respond(permissionEvent.envelope.id, {
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
  }

  const updateEvent = await waitForEvent(events, (event) => isMethod(event.envelope, 'session/update'));
  console.log('update:', updateEvent.envelope);

  const result = await promptPromise;
  console.log('turn finished:', result.stopReason); // 'end_turn' | 'cancelled' | ...

  // Cancelling mid-turn is a fire-and-forget notification; a pending
  // `client.prompt()` call resolves once the harness reports the turn as
  // stopped. Called here after the turn already finished, purely to
  // demonstrate the call — a real caller invokes it while a prompt is
  // in flight.
  await client.cancel(session.sessionId);

  handle.close();
}

const baseUrl = process.env.ACP_BRIDGE_BASE_URL;
const serverId = process.env.ACP_BRIDGE_SERVER_ID;
const signedContextHeader = process.env.ACP_BRIDGE_SIGNED_CONTEXT;

if (!baseUrl || !serverId || !signedContextHeader) {
  console.log('Set ACP_BRIDGE_BASE_URL, ACP_BRIDGE_SERVER_ID, and ACP_BRIDGE_SIGNED_CONTEXT to run this example against a real bridge.');
} else {
  main(baseUrl, serverId, signedContextHeader).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
