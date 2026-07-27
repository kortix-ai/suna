#!/usr/bin/env bun
/**
 * Dump the authoritative API route table to JSON for the ke2e coverage gate.
 *
 * Imports the real Hono app (no server boot — index.ts guards startup behind
 * import.meta.main) and reads app.routes, the single source of truth for which
 * method+path combinations exist. Normalizes duplicates and Hono's per-middleware
 * "ALL" entries down to concrete handler routes.
 *
 *   bun run apps/api/scripts/dump-routes.ts [outpath]
 *   (default outpath: tests/spec/routes.generated.json)
 *
 * Run with placeholder env if config validation needs it (see tests CI).
 *
 * The route table is ENV-SENSITIVE — two flags decide whether whole routers
 * mount, so regenerating with the wrong ones silently rewrites the manifest
 * and moves the coverage gate:
 *   KORTIX_BILLING_INTERNAL_ENABLED=true  hides /v1/setup/* (self-host only)
 *   LLM_GATEWAY_ENABLED=true              mounts the in-API /v1/llm/* surface
 * Both must be `true` — that is the managed/cloud deployment the manifest
 * describes. A local .env with billing off adds nine /v1/setup routes and
 * drops seven /v1/llm ones. Regenerate with:
 *
 *   cd apps/api && SUPABASE_URL=https://placeholder.supabase.co \
 *     INTERNAL_KORTIX_ENV=dev KORTIX_BILLING_INTERNAL_ENABLED=true \
 *     LLM_GATEWAY_ENABLED=true bun scripts/dump-routes.ts
 */
import { resolve } from "node:path";
import { app } from "../src/index";

interface RouteEntry {
  method: string;
  path: string;
}

const seen = new Set<string>();
const routes: RouteEntry[] = [];

for (const r of (app as any).routes as Array<{ method: string; path: string; handler: unknown }>) {
  const method = r.method.toUpperCase();
  // Skip middleware-only registrations (Hono lists `ALL` + `use` entries).
  if (method === "ALL") continue;
  // Skip Hono's internal/star-only middleware mounts.
  if (r.path.endsWith("/*") && method === "ALL") continue;
  const key = `${method} ${r.path}`;
  if (seen.has(key)) continue;
  seen.add(key);
  routes.push({ method, path: r.path });
}

routes.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));

const out = resolve(import.meta.dir, "../../../tests/spec/routes.generated.json");
const target = process.argv[2] ? resolve(process.argv[2]) : out;
await Bun.write(target, JSON.stringify({ generatedAt: "static", count: routes.length, routes }, null, 2) + "\n");
process.stderr.write(`[dump-routes] wrote ${routes.length} routes → ${target}\n`);
process.exit(0);
