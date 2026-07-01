/**
 * Setup-link PUBLIC app — the unauthenticated half, mounted at /v1/setup-links.
 *
 * The agent-minted link's bearer capability IS the (encrypted, short-lived,
 * value-only) token, so these routes deliberately require no login: a teammate
 * who taps the link from a Slack message on their phone must be able to fill it
 * in. Resolve returns NO secret values — only the requested field names. Submit
 * can only write the names sealed into the token, into the one project the token
 * is for. Same trust model as a magic link / a Pipedream connect URL.
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { projects } from "@kortix/db";
import { Effect } from "effect";
import {
  isValidSecretName,
  writeSharedProjectSecret,
} from "../projects/secrets";
import { propagateProjectSecretsToActiveSandboxes } from "../projects/lib/sandbox-env-sync";
import {
  pipedreamConfigured,
  pipedreamConnectUrl,
} from "../executor/pipedream";
import { DatabaseService } from "../effect/services";
import { runEffectOrThrow } from "../effect/http";
import { effectHandler, effectMiddleware } from "../effect/hono";
import { resolveSetupLink } from "./token";

const setupLinksPublicApp = new Hono();
setupLinksPublicApp.use("*", effectMiddleware);

async function projectName(projectId: string): Promise<string> {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const [row] = yield* Effect.tryPromise(() =>
      database
        .select({ name: projects.name })
        .from(projects)
        .where(eq(projects.projectId, projectId))
        .limit(1),
    );
    return row?.name ?? "this project";
  }));
}

// GET /v1/setup-links/secret/:token — what fields does this link ask for?
setupLinksPublicApp.get(
  "/secret/:token",
  effectHandler(async (c) => {
    const resolved = resolveSetupLink(c.req.param("token"));
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    if (resolved.payload.kind !== "secret")
      return c.json({ error: "Wrong link type" }, 400);

    return c.json({
      kind: "secret",
      project_name: await projectName(resolved.projectId),
      fields: resolved.payload.fields.map((f) => ({
        name: f.name,
        label: f.label ?? null,
        description: f.description ?? null,
      })),
      expires_at: new Date(resolved.payload.exp).toISOString(),
    });
  }),
);

// POST /v1/setup-links/secret/:token — { values: { NAME: value } }
setupLinksPublicApp.post(
  "/secret/:token",
  effectHandler(async (c) => {
    const resolved = resolveSetupLink(c.req.param("token"));
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    if (resolved.payload.kind !== "secret")
      return c.json({ error: "Wrong link type" }, 400);

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const values = (body?.values ?? {}) as Record<string, unknown>;
    const allowed = new Set(resolved.payload.fields.map((f) => f.name));

    const saved: string[] = [];
    for (const [rawName, rawValue] of Object.entries(values)) {
      const name = rawName.toUpperCase();
      // Value-only: silently ignore anything the token didn't ask for, and never
      // let a leaked token write to a key it doesn't name.
      if (!allowed.has(name) || !isValidSecretName(name)) continue;
      const value = typeof rawValue === "string" ? rawValue : "";
      if (!value) continue;
      await writeSharedProjectSecret({
        projectId: resolved.projectId,
        name,
        value,
        scope: resolved.payload.scope,
        createdBy: resolved.payload.uid,
      });
      saved.push(name);
    }

    if (saved.length === 0) {
      return c.json(
        { error: "No values provided for the requested keys" },
        400,
      );
    }

    // Live-propagate so an active session sees the new value without a restart.
    void propagateProjectSecretsToActiveSandboxes(resolved.projectId);

    return c.json({ ok: true, saved });
  }),
);

// GET /v1/setup-links/connector/:token — which app does this link connect?
setupLinksPublicApp.get(
  "/connector/:token",
  effectHandler(async (c) => {
    const resolved = resolveSetupLink(c.req.param("token"));
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    if (resolved.payload.kind !== "connector")
      return c.json({ error: "Wrong link type" }, 400);

    return c.json({
      kind: "connector",
      project_name: await projectName(resolved.projectId),
      slug: resolved.payload.slug,
      app: resolved.payload.app,
      expires_at: new Date(resolved.payload.exp).toISOString(),
    });
  }),
);

// POST /v1/setup-links/connector/:token/start — mint a FRESH Pipedream Quick
// Connect URL. Completing on Pipedream's hosted page fires the connect webhook,
// which persists the credential (see executor/pipedream.ts createConnectToken
// webhook_uri + db-deps pipedreamWebhook), so no explicit finalize is needed.
setupLinksPublicApp.post(
  "/connector/:token/start",
  effectHandler(async (c) => {
    const resolved = resolveSetupLink(c.req.param("token"));
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    if (resolved.payload.kind !== "connector")
      return c.json({ error: "Wrong link type" }, 400);
    if (!pipedreamConfigured())
      return c.json(
        { error: "Pipedream is not configured on this deployment" },
        501,
      );
    if (!resolved.payload.app)
      return c.json(
        { error: "This connector has no Pipedream app bound" },
        400,
      );

    const effectiveUser =
      resolved.payload.mode === "per_user" ? resolved.payload.uid : null;
    try {
      const { connectUrl } = await pipedreamConnectUrl(
        resolved.projectId,
        resolved.payload.slug,
        resolved.payload.app,
        effectiveUser,
      );
      if (!connectUrl)
        return c.json({ error: "Pipedream did not return a connect URL" }, 502);
      return c.json({ connect_url: connectUrl });
    } catch (err) {
      return c.json(
        {
          error: err instanceof Error ? err.message : "Failed to start connect",
        },
        502,
      );
    }
  }),
);

export { setupLinksPublicApp };
