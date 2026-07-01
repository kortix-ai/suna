import { createRoute, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import { Effect } from "effect";
import { accessRequests } from "@kortix/db";
import { areSignupsEnabled, canSignUp } from "../shared/access-control-cache";
import { makeOpenApiApp, json, errors } from "../openapi";
import { effectHandler } from "../effect/hono";
import { DatabaseService } from "../effect/services";
import { runEffectOrThrow } from "../effect/http";

export const accessControlApp = makeOpenApiApp();

async function userExistsInAuth(email: string): Promise<boolean> {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database, hasDatabase } = yield* DatabaseService;
    if (!hasDatabase) return false;
    const result = yield* Effect.tryPromise(() =>
      database.execute(sql`
      SELECT 1 FROM auth.users WHERE email = ${email.trim().toLowerCase()} LIMIT 1
    `),
    ).pipe(Effect.catchAll(() => Effect.succeed([])));
    if (Array.isArray(result)) return result.length > 0;
    const rows = (result as { rows?: unknown[] } | null)?.rows;
    return Array.isArray(rows) && rows.length > 0;
  }));
}

// ─── Public endpoints (no auth) ───────────────────────────────────────────────

accessControlApp.openapi(
  createRoute({
    method: "get",
    path: "/signup-status",
    tags: ["access"],
    summary: "Whether public signups are currently open",
    responses: {
      200: json(
        z.object({ signupsEnabled: z.boolean() }),
        "Signup availability",
      ),
    },
  }),
  effectHandler((c: any) => c.json({ signupsEnabled: areSignupsEnabled() })),
);

accessControlApp.openapi(
  createRoute({
    method: "post",
    path: "/check-email",
    tags: ["access"],
    summary: "Check whether an email is allowed to sign up",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ email: z.string().email() }),
          },
        },
      },
    },
    responses: {
      200: json(
        z.object({ allowed: z.boolean() }),
        "Whether the email may sign up",
      ),
      ...errors(400),
    },
  }),
  effectHandler(async (c: any) => {
    const { email } = c.req.valid("json");
    if (canSignUp(email)) return c.json({ allowed: true });
    if (await userExistsInAuth(email)) return c.json({ allowed: true });
    return c.json({ allowed: false });
  }),
);

accessControlApp.openapi(
  createRoute({
    method: "post",
    path: "/request-access",
    tags: ["access"],
    summary: "Submit an early-access / waitlist request",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              email: z.string().email(),
              company: z.string().optional(),
              useCase: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: json(
        z.object({ success: z.boolean(), message: z.string() }),
        "Request submitted",
      ),
      ...errors(400),
    },
  }),
  effectHandler(async (c: any) => {
    const body = c.req.valid("json");
    await runEffectOrThrow(Effect.gen(function* () {
      const { database } = yield* DatabaseService;
      yield* Effect.tryPromise(() =>
        database.insert(accessRequests).values({
          email: body.email.trim().toLowerCase(),
          company: body.company || null,
          useCase: body.useCase || null,
        }),
      );
    }));
    return c.json({ success: true, message: "Access request submitted" });
  }),
);
