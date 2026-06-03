/**
 * Shared OpenAPI wiring for the Kortix API.
 *
 * Every sub-router is an `OpenAPIHono` created via `makeOpenApiApp()` so it (a)
 * contributes typed route definitions to the spec and (b) shares one validation
 * error contract. Routes are defined with `createRoute()` + zod; the spec is
 * served at /v1/openapi.json and rendered by Scalar at /v1/docs.
 */
import { OpenAPIHono, z, type RouteConfig } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";

/** Permissive error envelope — matches the platform's `{error,message,status}` 404 shape. */
export const ErrorSchema = z
  .object({
    error: z.union([z.boolean(), z.string()]).optional(),
    message: z.string().optional(),
    code: z.string().optional(),
    status: z.number().optional(),
  })
  .openapi("Error");

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

/** Standard error responses for the given status codes, keyed for `responses`. */
export const errors = (...codes: number[]): Record<number, ReturnType<typeof json>> =>
  Object.fromEntries(codes.map((c) => [c, json(ErrorSchema, STATUS_TEXT[c] ?? "Error")]));

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
export function makeOpenApiApp() {
  return new OpenAPIHono({ defaultHook });
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
      description: "The Kortix platform REST API — typed schemas via @hono/zod-openapi.",
    },
    servers: [{ url: new URL(c.req.url).origin }],
  }));

  app.get("/v1/docs", Scalar({ url: "/v1/openapi.json", pageTitle: "Kortix API" }));
}
