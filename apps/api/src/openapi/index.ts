/**
 * Shared OpenAPI wiring for the Kortix API.
 *
 * Every sub-router is an `OpenAPIHono` created via `makeOpenApiApp()` so it (a)
 * contributes typed route definitions to the spec and (b) shares one validation
 * error contract. Routes are defined with `createRoute()` + zod; the spec is
 * served at /v1/openapi.json and rendered by Scalar at /v1/docs.
 */
import { OpenAPIHono, z, type RouteConfig } from "@hono/zod-openapi";
import { ErrorEnvelopeSchema } from "@kortix/api-contract";
import type { Env } from "hono";
import { Scalar } from "@scalar/hono-api-reference";

/** Permissive error envelope — matches the platform's `{error,message,status}` 404 shape. */
export const ErrorSchema = ErrorEnvelopeSchema.openapi("Error");

const STATUS_TEXT: Record<number, string> = {
  400: "Bad request",
  401: "Unauthorized",
  402: "Payment required",
  403: "Forbidden",
  404: "Not found",
  409: "Conflict",
  410: "Gone",
  429: "Rate limited",
  500: "Server error",
  501: "Not implemented",
  502: "Bad gateway",
  503: "Service unavailable",
};

/** A JSON response entry for a createRoute `responses` map. */
export const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

/**
 * Standard error responses for the given status codes, keyed for `responses`.
 * Generic over the literal codes so the keys stay literal (e.g. `401`, not
 * `number`) — zod-openapi's typed handler needs the literal status union, so a
 * widened `Record<number,…>` would break `c.json(body, 401)` handler typing.
 */
export const errors = <C extends number>(...codes: C[]): { [K in C]: ReturnType<typeof json> } =>
  Object.fromEntries(codes.map((c) => [c, json(ErrorSchema, STATUS_TEXT[c] ?? "Error")])) as unknown as {
    [K in C]: ReturnType<typeof json>;
  };

/** Mark an operation as requiring a bearer token. */
export const auth: Pick<RouteConfig, "security"> = { security: [{ bearerAuth: [] }] };

/**
 * Single validation-error contract for every typed route. Zod failures (bad body,
 * params, query) become a consistent 400 envelope instead of per-route ad-hoc shapes.
 */
function defaultHook(result: { success: boolean; error?: { issues: unknown } }, c: any) {
  if (!result.success) {
    return c.json(
      { error: true, message: "Validation failed", status: 400, issues: result.error?.issues },
      400,
    );
  }
}

/** Create an OpenAPIHono sub-app with the shared error contract. */
export function makeOpenApiApp<E extends Env = Env>() {
  return new OpenAPIHono<E>({ defaultHook });
}

/** Register security + serve the spec (/v1/openapi.json) and Scalar UI (/v1/docs). */
export function mountOpenApiDocs(app: OpenAPIHono<any, any, any>, version: string): void {
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description:
      "Supabase user JWT, or a Kortix token: PAT (`kortix_pat_…`), API key (`kortix_…`), or service account (`kortix_sa_…`).",
  });

  app.doc31("/v1/openapi.json", (c) => ({
    openapi: "3.1.0",
    info: {
      title: "Kortix API",
      version,
      description:
        "The Kortix platform REST API — typed schemas via @hono/zod-openapi. " +
        "For application code, prefer the TypeScript SDK (`@kortix/sdk`), which wraps " +
        "this API and the agent runtime behind one session-scoped client — " +
        "docs at https://kortix.com/docs/sdk.",
    },
    servers: [{ url: new URL(c.req.url).origin }],
  }));

  app.get("/v1/docs", Scalar({ url: "/v1/openapi.json", pageTitle: "Kortix API" }));
}
