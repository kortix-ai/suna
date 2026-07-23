/**
 * 09 — "Kortix as a Backend", the whole flow in one file.
 *
 * Wrap ONE shared Kortix agent + repo as the backend for MANY of your own
 * end-users. Your service holds a single Kortix API key; every session it
 * starts brings *that* user's connector, model, secrets, and identity BY
 * REFERENCE. Your end-users never log in to Kortix.
 *
 * This example does the entire path with no browser:
 *   1. mint a CONNECTOR definition           (headless: mcp/http/openapi/graphql)
 *   2. mint a per-end-user connection PROFILE (owner_type 'external' = your user)
 *      + store that user's own credential + activate it            (by reference)
 *   3. start a BACKEND-origin session, binding the profile, pinning the model
 *      and agent, vouching via origin_ref, and narrowing secrets      (overrides)
 *   4. STREAM the agent's answer live to your terminal / your own SSE endpoint
 *
 * Two run modes in this one file:
 *   One-shot CLI  → streams a single turn to stdout:
 *     KORTIX_API_URL=http://localhost:8008/v1 KORTIX_API_KEY=kortix_pat_... \
 *     KORTIX_PROJECT_ID=... \
 *       bun run examples/09-kaab-backend-wrapper.ts "Summarize my new signups"
 *
 *   Multi-tenant service → POST /run {endUserId, prompt}, re-emitted as SSE:
 *     MODE=serve KORTIX_API_URL=... KORTIX_API_KEY=kortix_pat_... KORTIX_PROJECT_ID=... \
 *       bun run examples/09-kaab-backend-wrapper.ts
 *     curl -N localhost:8791/run -H 'content-type: application/json' \
 *       -d '{"endUserId":"alice","prompt":"Summarize my new signups"}'
 *
 * Notes:
 *   - `origin_ref` + `secrets` are backend-only fields that require the
 *     Kortix-as-a-Backend release. Set KAAB_OVERRIDES=off to drop them so the
 *     connector + binding + session + streaming path still runs against a
 *     deployment that doesn't have them yet (origin still auto-derives to
 *     'backend' from the API key).
 *   - Bun only — the `@kortix/sdk/server` subpath statically imports
 *     node:async_hooks (standard on Node 18+/22).
 *
 * As an npm consumer:
 *   import { createScopedKortix } from '@kortix/sdk/server';
 */
import { createScopedKortix } from "../src/node/server";

// ─── config (env) ────────────────────────────────────────────────────────────
const backendUrl = process.env.KORTIX_API_URL ?? "http://localhost:8008/v1";
const upstreamApiKey = process.env.KORTIX_API_KEY; // the wrapper's own kortix_pat_ → origin 'backend'
const projectId = process.env.KORTIX_PROJECT_ID;
const includeOverrides = process.env.KAAB_OVERRIDES !== "off";

// Which connector/agent/model/secret this wrapper drives — all overridable.
const CONNECTOR_SLUG = process.env.KAAB_CONNECTOR_SLUG ?? "user-mcp";
const CONNECTOR_ENDPOINT =
  process.env.KAAB_CONNECTOR_ENDPOINT ?? "https://mcp.example.com/mcp";
const AGENT_NAME = process.env.KAAB_AGENT; // undefined → project default agent
const MODEL = process.env.KAAB_MODEL; // undefined → project/agent default model
const SECRET_ID = process.env.KAAB_SECRET; // one project-secret identifier to narrow to

if (!upstreamApiKey || !projectId) {
  console.error(
    "Set KORTIX_API_KEY (a kortix_pat_ from Settings → Tokens) and KORTIX_PROJECT_ID.",
  );
  process.exit(1);
}

/**
 * Resolve the upstream Kortix credential for one of YOUR end-users. A real
 * wrapper mints/stores one PAT per tenant (or scopes a shared one) in its own
 * auth store, keyed off the incoming request — never a hardcoded env var. Here
 * every user shares the wrapper's own key; origin still derives to 'backend',
 * and per-user isolation comes from origin_ref + the end-user's connection
 * profile, not from distinct Kortix logins.
 */
function upstreamTokenFor(_endUserId: string): string {
  return upstreamApiKey!;
}

/** Build a request-scoped SDK client bound to one end-user's upstream token. */
function clientFor(endUserId: string) {
  return createScopedKortix({
    backendUrl,
    getToken: async () => upstreamTokenFor(endUserId),
  });
}

// ─── step 1: mint the connector definition (once per connector) ──────────────
async function ensureConnector(
  kortix: ReturnType<typeof clientFor>,
): Promise<void> {
  const project = kortix.project(projectId!);
  const existing = await project.connectors
    .list()
    .catch(() => ({ connectors: [] as { slug: string }[] }));
  if (existing.connectors?.some((c) => c.slug === CONNECTOR_SLUG)) return;

  // A headless connector: an MCP server reached over HTTP with a per-user
  // bearer credential. `provider` mcp/http/openapi/graphql all take a static
  // credential and need no OAuth (pipedream is the browser-only exception).
  // NB: an `mcp` connector uses `url` (openapi/postman use `spec`, http uses
  // `baseUrl`). The connector must be declared in the project's kortix.yaml for
  // per-user PROFILES to reconcile against it.
  await project.connectors.create({
    slug: CONNECTOR_SLUG,
    provider: "mcp",
    transport: "http",
    url: CONNECTOR_ENDPOINT,
    credential: "shared",
    auth: {
      type: "bearer",
      in: "header",
      name: "Authorization",
      prefix: "Bearer ",
    },
  });
}

// ─── step 2: mint + credential + activate this user's connection profile ─────
/** Returns the `profile_id` you bind by reference, or null if the project has
 *  no connector declared (a bare project without kortix.yaml). Idempotent per
 *  (connector, owner). `owner_type: 'external'` = your app's user, independent
 *  of any Kortix member/agent. */
async function ensureUserProfile(
  kortix: ReturnType<typeof clientFor>,
  endUserId: string,
  usersOwnCredential: string,
): Promise<string | null> {
  const project = kortix.project(projectId!);
  try {
    const profile = await project.connectors.profiles.reconcile({
      connector_alias: CONNECTOR_SLUG,
      owner_type: "external",
      owner_id: endUserId,
      label: `${CONNECTOR_SLUG} for ${endUserId}`,
    });
    // Store THAT user's own credential (never sent again; resolved server-side
    // at connector-call time — it never enters the sandbox env).
    await project.connectors.profiles.updateCredential(profile.profile_id, {
      value: usersOwnCredential,
      kind: "secret",
    });
    await project.connectors.profiles.activate(profile.profile_id);
    return profile.profile_id;
  } catch (err) {
    // ONLY the "connector not declared in the project's kortix.yaml" case (404)
    // is a benign skip — run the rest of the flow without a binding. Every other
    // failure (403 auth, invalid credential, network) MUST surface: swallowing
    // it would run the agent FOR this user WITHOUT their credential — a silent
    // security footgun in a copied backend.
    const status = (err as { status?: number }).status;
    if (status === 404) {
      console.error(
        `[connector] "${CONNECTOR_SLUG}" is not declared in the project manifest — ` +
          `running without a per-user binding. Add it to kortix.yaml to enable.`,
      );
      return null;
    }
    throw err;
  }
}

// ─── step 3: start a backend-origin session bound to this user ───────────────
async function startSession(
  kortix: ReturnType<typeof clientFor>,
  endUserId: string,
  profileId: string | null,
): Promise<string> {
  const body: Record<string, unknown> = {
    // Bind the connector alias → this user's profile (credential by reference).
    // NB: connector_bindings is all-or-nothing — bind every alias the agent needs.
    ...(profileId
      ? { connector_bindings: { [CONNECTOR_SLUG]: { profile_id: profileId } } }
      : {}),
    ...(AGENT_NAME ? { agent_name: AGENT_NAME } : {}),
    ...(MODEL ? { model: MODEL } : {}),
    // Backend-only fields (require the KaaB release; KAAB_OVERRIDES=off drops them):
    ...(includeOverrides
      ? {
          origin_ref: endUserId, // attribution → KORTIX_ORIGIN_REF in the sandbox
          ...(SECRET_ID ? { secrets: [SECRET_ID] } : {}), // narrow injected secrets
        }
      : {}),
  };
  const session = await kortix.project(projectId!).sessions.create(body);
  console.error(
    `[session ${session.session_id}] origin=${session.origin ?? "(n/a)"}` +
      ` origin_ref=${session.origin_ref ?? "(n/a)"} secrets=${JSON.stringify(session.secrets_allowlist ?? null)}`,
  );
  return session.session_id;
}

// ─── step 4: stream the turn ─────────────────────────────────────────────────
/** Drive one turn and stream its text deltas to `onText`; resolves when the
 *  session goes idle (turn complete). */
async function runTurn(
  kortix: ReturnType<typeof clientFor>,
  sessionId: string,
  prompt: string,
  onText: (delta: string) => void,
): Promise<void> {
  const session = kortix.session(projectId!, sessionId);
  // ensureReady() blocks while polling the sandbox cold start. Pass
  // `{ deadlineMs }` to change the default five-minute deadline.
  // THEN we stream, so the stream is connected before the prompt goes out and no
  // early events are missed (see example 02).
  //
  // Streaming precondition: the sandbox must be able to reach YOUR Kortix API
  // (its KORTIX_URL) to finish booting OpenCode. A hosted deployment satisfies
  // this out of the box; against a LOCAL API a cloud sandbox cannot reach
  // localhost, so front the API with a public tunnel (e.g.
  // `cloudflared tunnel --url http://localhost:8010`) and start it with
  // KORTIX_URL set to that tunnel URL.
  await session.ensureReady();

  const handle = await session.stream({
    onEvent: (event) => {
      const envelope = event.envelope as {
        method?: string;
        params?: {
          update?: {
            sessionUpdate?: string;
            type?: string;
            content?: unknown;
          };
        };
      };
      if (envelope.method !== "session/update") return;
      const update = envelope.params?.update;
      if ((update?.sessionUpdate ?? update?.type) !== "agent_message_chunk")
        return;
      const content = Array.isArray(update?.content)
        ? update.content
        : [update?.content];
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string"
        ) {
          onText((block as { text: string }).text);
        }
      }
    },
  });
  try {
    await session.send(prompt);
  } finally {
    handle.close();
  }
}

/** Full flow for one end-user + prompt, streaming text to `onText`. */
async function serveOneUser(
  endUserId: string,
  prompt: string,
  onText: (t: string) => void,
) {
  const kortix = clientFor(endUserId);
  // The connector layer is optional: on a bare project (no kortix.yaml / no
  // connector) it degrades to "no binding" and the session + streaming path
  // still runs. Set KAAB_NO_CONNECTOR=1 to skip it entirely.
  let profileId: string | null = null;
  if (process.env.KAAB_NO_CONNECTOR !== "1") {
    try {
      await ensureConnector(kortix);
      // In a real wrapper this credential is the user's own connected account.
      profileId = await ensureUserProfile(
        kortix,
        endUserId,
        process.env.KAAB_USER_CREDENTIAL ?? "placeholder-token",
      );
    } catch (err) {
      console.error(
        `[connector] unavailable, continuing without a binding: ${String(err)}`,
      );
    }
  }
  const sessionId = await startSession(kortix, endUserId, profileId);
  await runTurn(kortix, sessionId, prompt, onText);
}

// ─── run modes ───────────────────────────────────────────────────────────────
async function oneShot() {
  const prompt = process.argv[2] ?? "Say hello in one sentence.";
  const endUserId = process.env.KAAB_END_USER ?? "demo-user";
  console.error(`> [${endUserId}] ${prompt}\n`);
  await serveOneUser(endUserId, prompt, (t) => process.stdout.write(t));
  process.stdout.write("\n\n[turn complete]\n");
}

function serve() {
  const port = Number(process.env.PORT ?? 8791);
  Bun.serve({
    port,
    async fetch(req: Request) {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== "/run") {
        return new Response("POST /run {endUserId, prompt}", { status: 404 });
      }
      const { endUserId = "anonymous", prompt = "" } = (await req
        .json()
        .catch(() => ({}))) as {
        endUserId?: string;
        prompt?: string;
      };
      // Re-emit the agent's text deltas to the caller as text/event-stream.
      const stream = new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder();
          try {
            await serveOneUser(endUserId, prompt, (t) =>
              controller.enqueue(enc.encode(`data: ${JSON.stringify(t)}\n\n`)),
            );
            controller.enqueue(enc.encode("event: done\ndata: {}\n\n"));
          } catch (err) {
            controller.enqueue(
              enc.encode(
                `event: error\ndata: ${JSON.stringify(String(err))}\n\n`,
              ),
            );
          } finally {
            controller.close();
          }
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    },
  });
  console.error(
    `KaaB wrapper listening on :${port} — POST /run {endUserId, prompt}`,
  );
}

if (process.env.MODE === "serve") {
  serve();
} else {
  oneShot().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
