#!/usr/bin/env bun
/**
 * Dump the authoritative API route table to JSON for the ke2e coverage gate.
 *
 * Imports the real Hono app (no server boot — index.ts guards startup behind
 * import.meta.main) and reads app.routes, the single source of truth for which
 * method+path combinations exist. Keeps every concrete handler, including the
 * `.all()` passthroughs (`/v1/llm/*`, `/v1/p/*`, `/v1/router/<provider>`), which
 * it emits with method `ALL`, and drops `use()` middleware.
 *
 *   bun run apps/api/scripts/dump-routes.ts [outpath]
 *   (default outpath: tests/spec/routes.generated.json)
 *
 * Run with placeholder env if config validation needs it (see tests CI).
 *
 * The route table is ENV-SENSITIVE — one flag decides whether a whole router
 * mounts, so regenerating with the wrong value silently rewrites the manifest
 * and moves the coverage gate:
 *   KORTIX_BILLING_INTERNAL_ENABLED=true  hides /v1/setup/* (self-host only)
 * It must be `true` — that is the managed/cloud deployment the manifest
 * describes. A local .env with billing off adds nine /v1/setup routes.
 * Regenerate with:
 *
 *   cd apps/api && SUPABASE_URL=https://placeholder.supabase.co \
 *     INTERNAL_KORTIX_ENV=dev KORTIX_BILLING_INTERNAL_ENABLED=true \
 *     FRONTEND_URL=https://placeholder.kortix.com \
 *     KORTIX_CONFIG_ARCHIVE_S3_ENDPOINT=https://placeholder.storage.example \
 *     PLATINUM_INFERENCE_URL=https://placeholder.platinum.example/v1/inference \
 *     bun scripts/dump-routes.ts
 *
 * The last three placeholders exist because bun auto-loads the dotenvx-encrypted
 * `.env`, so those three URL vars arrive as `encrypted:…` ciphertext and fail
 * config validation before the app imports. They do not change the route table.
 */
import { resolve } from "node:path";
import { workspaceAliasOf } from "@kortix/shared/workspace-routes";
import { app } from "../src/index";

interface RouteEntry {
  method: string;
  path: string;
  /**
   * The canonical route this one is a permanent legacy name of
   * (`/v1/projects/:workspaceId/sessions` → `/v1/workspaces/:workspaceId/sessions`).
   * Both run the same handler (unit-workspace-route-aliases.test.ts). The
   * coverage gate counts an alias as covered when its canonical route is.
   */
  aliasOf?: string;
}

const seen = new Set<string>();
const routes: RouteEntry[] = [];

for (const r of (app as any).routes as Array<{ method: string; path: string; handler: unknown }>) {
  const method = r.method.toUpperCase();
  // Hono lists `use()` middleware as `ALL` too. Middleware takes `(c, next)`;
  // an `.all()` handler takes `(c)`. Verified on the real table: every `ALL`
  // entry of arity 1 is a passthrough handler, every one of arity 2 middleware.
  if (method === "ALL" && (r.handler as (...args: unknown[]) => unknown).length >= 2) continue;
  const key = `${method} ${r.path}`;
  if (seen.has(key)) continue;
  seen.add(key);
  routes.push({ method, path: r.path });
}

// One alias rule for the manifest and the OpenAPI spec (`workspaceAliasOf`).
for (const r of routes) {
  const canonical = workspaceAliasOf(r.method, r.path, (m, p) => seen.has(`${m} ${p}`));
  if (canonical) r.aliasOf = canonical;
}

routes.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));

const out = resolve(import.meta.dir, "../../../tests/spec/routes.generated.json");
const target = process.argv[2] ? resolve(process.argv[2]) : out;
const aliases = routes.filter((r) => r.aliasOf).length;
await Bun.write(target, JSON.stringify({ generatedAt: "static", count: routes.length, aliases, routes }, null, 2) + "\n");
process.stderr.write(`[dump-routes] wrote ${routes.length} routes (${aliases} legacy aliases) → ${target}\n`);
process.exit(0);
