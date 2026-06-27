/**
 * Per-user model preferences — the server home for the LLM picker's
 * cross-device state.
 *
 * Mounted at `/v1/me/model-preferences`. Storage is keyed by the AUTH USER
 * (auth.users.id) ONLY — there is no project/account scoping here, so the
 * chosen default model and the per-model show/hide pins follow the human
 * everywhere they sign in. The browser localStorage store remains an optimistic
 * cache; these endpoints are its durable backing store.
 *
 *   GET    /v1/me/model-preferences            → { default, hidden[] }
 *   PUT    /v1/me/model-preferences/default    → upsert default_model
 *   PUT    /v1/me/model-preferences/visibility → upsert one visibility pin
 *   DELETE /v1/me/model-preferences/visibility → clear all visibility pins
 */
import { Context } from 'hono';
import { createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { userModelPreferences } from '@kortix/db';
import type { AppEnv } from '../types';
import { makeOpenApiApp, auth, json, errors } from '../openapi';
import { supabaseAuth } from '../middleware/auth';
import { db } from '../shared/db';

export const meRouter = makeOpenApiApp<AppEnv>();

// Resolve the human behind the request. supabaseAuth populates `userId` on the
// context (same field the accounts router reads).
meRouter.use('/*', supabaseAuth);

type VisibilityEntry = {
  providerID: string;
  modelID: string;
  visibility: 'show' | 'hide';
};

const VisibilityEntrySchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
  visibility: z.enum(['show', 'hide']),
});

const PreferencesSchema = z
  .object({
    default: z.string().nullable(),
    hidden: z.array(VisibilityEntrySchema),
  })
  .openapi('ModelPreferences');

async function readBody(c: Context): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) ?? {};
  } catch {
    return {};
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function loadPreferences(
  userId: string,
): Promise<{ default: string | null; hidden: VisibilityEntry[] }> {
  const [row] = await db
    .select()
    .from(userModelPreferences)
    .where(eq(userModelPreferences.userId, userId))
    .limit(1);
  return {
    default: row?.defaultModel ?? null,
    hidden: (row?.hiddenModels ?? []) as VisibilityEntry[],
  };
}

// GET /v1/me/model-preferences
meRouter.openapi(
  createRoute({
    method: 'get',
    path: '/model-preferences',
    tags: ['me'],
    summary: "The caller's model picker preferences",
    ...auth,
    responses: {
      200: json(PreferencesSchema, 'Default model + per-model visibility pins'),
      ...errors(401),
    },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    return c.json(await loadPreferences(userId));
  },
);

// PUT /v1/me/model-preferences/default — body { model: "providerID/modelID" | null }
meRouter.openapi(
  createRoute({
    method: 'put',
    path: '/model-preferences/default',
    tags: ['me'],
    summary: 'Set (or clear) the default model',
    ...auth,
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({ model: z.string().nullable() }),
          },
        },
      },
    },
    responses: {
      200: json(z.object({ default: z.string().nullable() }), 'Saved'),
      ...errors(401),
    },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const body = await readBody(c);
    const model = nonEmptyString(body.model);
    const now = new Date();
    await db
      .insert(userModelPreferences)
      .values({ userId, defaultModel: model, updatedAt: now })
      .onConflictDoUpdate({
        target: userModelPreferences.userId,
        set: { defaultModel: model, updatedAt: now },
      });
    return c.json({ default: model });
  },
);

// PUT /v1/me/model-preferences/visibility — body { providerID, modelID, visibility }
meRouter.openapi(
  createRoute({
    method: 'put',
    path: '/model-preferences/visibility',
    tags: ['me'],
    summary: 'Upsert one model visibility pin',
    ...auth,
    request: {
      body: { content: { 'application/json': { schema: VisibilityEntrySchema } } },
    },
    responses: {
      200: json(z.object({ hidden: z.array(VisibilityEntrySchema) }), 'Saved'),
      ...errors(400, 401),
    },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const body = await readBody(c);
    const providerID = nonEmptyString(body.providerID);
    const modelID = nonEmptyString(body.modelID);
    const visibility = body.visibility === 'hide' ? 'hide' : body.visibility === 'show' ? 'show' : null;
    if (!providerID || !modelID || !visibility) {
      return c.json({ error: 'providerID, modelID and visibility (show|hide) are required' }, 400);
    }

    const current = await loadPreferences(userId);
    const next: VisibilityEntry[] = [
      ...current.hidden.filter(
        (e) => !(e.providerID === providerID && e.modelID === modelID),
      ),
      { providerID, modelID, visibility },
    ];
    const now = new Date();
    await db
      .insert(userModelPreferences)
      .values({ userId, hiddenModels: next, updatedAt: now })
      .onConflictDoUpdate({
        target: userModelPreferences.userId,
        set: { hiddenModels: next, updatedAt: now },
      });
    return c.json({ hidden: next });
  },
);

// DELETE /v1/me/model-preferences/visibility — reset all pins
meRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/model-preferences/visibility',
    tags: ['me'],
    summary: 'Clear all model visibility pins',
    ...auth,
    responses: {
      200: json(z.object({ hidden: z.array(VisibilityEntrySchema) }), 'Cleared'),
      ...errors(401),
    },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const now = new Date();
    await db
      .insert(userModelPreferences)
      .values({ userId, hiddenModels: [], updatedAt: now })
      .onConflictDoUpdate({
        target: userModelPreferences.userId,
        set: { hiddenModels: [], updatedAt: now },
      });
    return c.json({ hidden: [] });
  },
);
