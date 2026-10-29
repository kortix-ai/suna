/**
 * System / health + access gating — public routes, no auth, no fixtures.
 * Maps 1:1 to spec §0 (SYS-*) and §3 (ACC-*).
 */
import { flow } from "../core/flow";

flow("SYS-1", { domain: "system", tags: ["deployed", "smoke", "health"], routes: ["GET /health", "GET /v1/health"] }, async (ctx) => {
  await ctx.step("GET /health", async () => {
    const r = await ctx.client.get("/health");
    r.status(200).body().has("$.status", "ok").has("$.service", "kortix-api").exists("$.version");
  });
  await ctx.step("GET /v1/health", async () => {
    const r = await ctx.client.get("/v1/health");
    r.status(200).body().has("$.status", "ok").has("$.service", "kortix-api");
    const body = JSON.parse(r.text()) as Record<string, unknown>;
    for (const field of ["instance", "region", "database_region", "scheduler_leader", "trigger_scheduler"]) {
      if (field in body) throw new Error(`public health exposed ${field}`);
    }
  });
});

flow("SYS-2", { domain: "system", tags: ["smoke"], routes: ["GET /v1/system/status"] }, async (ctx) => {
  await ctx.step("GET /v1/system/status", async () => {
    const r = await ctx.client.get("/v1/system/status");
    r.status(200).body().has("$.maintenanceNotice.enabled", false).has("$.technicalIssue.enabled", false);
  });
});

flow("SYS-6", { domain: "system", tags: ["smoke"], routes: ["GET /v1/system/maintenance"] }, async (ctx) => {
  await ctx.step("GET /v1/system/maintenance (public read) → 200 config", async () => {
    const r = await ctx.client.get("/v1/system/maintenance");
    // Public — banner + maintenance page read it unauthenticated. Default config
    // has level:"none"; either the default or a stored config is valid shape.
    r.status(200).body().exists("$.level");
  });
});

flow("SYS-7", { domain: "system", tags: ["smoke"], routes: ["POST /v1/system/demo-request"] }, async (ctx) => {
  await ctx.step("POST /v1/system/demo-request (invalid email) → 400", async () => {
    const r = await ctx.client.post("/v1/system/demo-request", { email: "not-an-email" });
    r.status(400);
  });
  await ctx.step("POST /v1/system/demo-request (valid) → 200 accepted", async () => {
    // Public lead capture. `emailed` is false when no email provider is configured on
    // the target env — the request is still accepted (graceful skip).
    const r = await ctx.client.post("/v1/system/demo-request", {
      name: "ke2e probe",
      email: `probe-${Date.now()}@ke2e.kortix.test`,
      company_name: "KE2E Labs",
      company_size: "51-200",
      source: "ke2e",
    });
    r.status(200).body().has("$.ok", true).exists("$.emailed");
  });
});

// SYS-10 — the mobile app reads its release policy BEFORE login, so the route is public.
// The values are operator settings (null when unset), so the flow asserts the shape on any target.
flow("SYS-10", { domain: "system", tags: ["smoke"], routes: ["GET /v1/clients/mobile"] }, async (ctx) => {
  const fields = ["minimum_version", "store_url_ios", "store_url_android"];
  const assertPolicy = (body: Record<string, unknown>) => {
    if (Object.keys(body).sort().join() !== [...fields].sort().join()) throw new Error(`unexpected keys: ${Object.keys(body)}`);
    for (const f of fields) if (body[f] !== null && typeof body[f] !== "string") throw new Error(`${f} is neither string nor null`);
  };
  await ctx.step("GET /v1/clients/mobile without Authorization → 200, each field a string or null", async () => {
    const r = await ctx.client.get("/v1/clients/mobile");
    r.status(200);
    assertPolicy(r.json());
  });
});

flow("SYS-11", { domain: "system", tags: ["smoke"], routes: ["GET /.well-known/security.txt", "GET /robots.txt", "GET /sitemap.xml"] }, async (ctx) => {
  await ctx.step("GET /.well-known/security.txt (public) → 200 text naming the security contact and a future Expires", async () => {
    const r = await ctx.client.get("/.well-known/security.txt");
    r.status(200).headerEquals("content-type", /text\/plain/);
    const expires = /^Expires: (.+)$/m.exec(r.text())?.[1];
    if (!r.text().includes("Contact: mailto:security@kortix.com") || !expires || Date.parse(expires) <= Date.now()) throw new Error(`security.txt: ${r.text()}`);
  });
  await ctx.step("GET /robots.txt (public) → 200 text that disallows every crawler path", async () => {
    const r = await ctx.client.get("/robots.txt");
    r.status(200).headerEquals("content-type", /text\/plain/);
    if (!/^User-agent: \*$/m.test(r.text()) || !/^Disallow: \/$/m.test(r.text())) throw new Error(`robots.txt: ${r.text()}`);
  });
  await ctx.step("GET /sitemap.xml (public) → 200 XML with an empty urlset", async () => {
    const r = await ctx.client.get("/sitemap.xml");
    r.status(200).headerEquals("content-type", /application\/xml/);
    if (!r.text().includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>')) throw new Error(`sitemap.xml: ${r.text()}`);
  });
});

flow("DOCS-1", { domain: "system", tags: ["smoke"], routes: ["GET /v1/openapi.json", "GET /v1/docs"] }, async (ctx) => {
  await ctx.step("GET /v1/openapi.json (public) → 200 OpenAPI 3.1 spec", async () => {
    const r = await ctx.client.get("/v1/openapi.json");
    r.status(200).body().has("$.openapi", "3.1.0").exists("$.info.title");
  });
  await ctx.step("every paged project list documents its paging parameters (KRTX-3393, KRTX-3389)", async () => {
    type Op = { parameters?: Array<{ name: string; in: string; schema?: { description?: string } }> };
    const spec = (await ctx.client.get("/v1/openapi.json")).json<{ paths: Record<string, { get?: Op }> }>();
    const wrong: string[] = [];
    for (const [path, names] of [
      ["/v1/projects/{projectId}/change-requests", ["limit", "cursor"]],
      ["/v1/projects/{projectId}/review/items", ["limit", "cursor"]],
      ["/v1/projects/{projectId}/gateway/logs", ["limit", "offset"]],
    ] as const) {
      const query = (spec.paths[path]?.get?.parameters ?? []).filter((p) => p.in === "query");
      for (const name of names) {
        const param = query.find((p) => p.name === name);
        if (!param?.schema?.description) wrong.push(`${path} lacks a described ${name}`);
      }
    }
    if (wrong.length) throw new Error(wrong.join("\n"));
  });
  await ctx.step("GET /v1/docs (public) → 200 Scalar reference HTML", async () => {
    const r = await ctx.client.get("/v1/docs");
    r.status(200).headerEquals("content-type", /html/);
  });
});

flow("SYS-4", { domain: "system", tags: ["smoke", "health"], routes: ["GET /v1/router/health"] }, async (ctx) => {
  await ctx.step("GET /v1/router/health", async () => {
    const r = await ctx.client.get("/v1/router/health");
    r.status(200).body().has("$.status", "ok").has("$.service", "kortix-router");
  });
});

// SYS-8 — the kubelet liveness probe (apps/api/src/index.ts, livenessHandler):
// samples ACTUAL event-loop lag rather than always answering instantly like
// /health does, so a degraded-but-not-dead pod gets restarted. Unversioned +
// /v1 forms both wired so either can be the chart's livenessPath. Under normal
// load `event_loop_lag_ms` stays well under the 5000ms default threshold, so a
// live run should always see {status:"ok", event_loop_lag_ms}.
flow("SYS-8", { domain: "system", tags: ["deployed", "smoke", "health"], routes: ["GET /health/live", "GET /v1/health/live", "GET /health/ready", "GET /v1/health/ready"] }, async (ctx) => {
  await ctx.step("GET /health/live", async () => {
    const r = await ctx.client.get("/health/live");
    r.status(200).body().has("$.status", "ok").exists("$.event_loop_lag_ms");
  });
  await ctx.step("GET /v1/health/live", async () => {
    const r = await ctx.client.get("/v1/health/live");
    r.status(200).body().has("$.status", "ok").exists("$.event_loop_lag_ms");
  });
  await ctx.step("GET /health/ready", async () => {
    const r = await ctx.client.get("/health/ready");
    r.status([200, 503]);
  });
  await ctx.step("GET /v1/health/ready", async () => {
    const r = await ctx.client.get("/v1/health/ready");
    r.status([200, 503]);
  });
});

flow("SYS-5", { domain: "system", tags: ["deployed", "smoke"], routes: ["GET /v1/accounts/me"] }, async (ctx) => {
  await ctx.step("404 shape on unknown route", async () => {
    const r = await ctx.client.get("/v1/this-route-does-not-exist");
    r.status(404).body().has("$.error", true).has("$.message", "Not found").has("$.status", 404);
  });
  await ctx.step("protected route without auth → 401", async () => {
    const r = await ctx.client.get("/v1/accounts/me");
    r.status(401);
  });
});

flow("ACC-1", { domain: "access", tags: ["smoke"], routes: ["GET /v1/access/signup-status"] }, async (ctx) => {
  await ctx.step("GET /v1/access/signup-status", async () => {
    const r = await ctx.client.get("/v1/access/signup-status");
    r.status(200).body().exists("$.signupsEnabled");
  });
});

flow("ACC-2", { domain: "access", tags: [], routes: ["POST /v1/access/check-email", "GET /v1/access/signup-status"] }, async (ctx) => {
  await ctx.step("POST /v1/access/check-email (missing email) → 400", async () => {
    const r = await ctx.client.post("/v1/access/check-email", {});
    r.status(400);
  });
  await ctx.step("POST /v1/access/check-email (valid) → 200 with flow mode", async () => {
    const r = await ctx.client.post("/v1/access/check-email", { email: `probe-${Date.now()}@ke2e.kortix.test` });
    r.status(200).body().exists("$.allowed").exists("$.mode");
  });
  await ctx.step("POST /v1/access/check-email (malformed email) → 400", async () => {
    const r = await ctx.client.post("/v1/access/check-email", { email: "not-an-email" });
    r.status(400);
  });
  await ctx.step("a new address → {allowed:true, mode:'signup'} while signups are open; allowed matches mode otherwise", async () => {
    const status = await ctx.client.get("/v1/access/signup-status");
    status.status(200);
    const open = status.json<{ signupsEnabled: boolean }>().signupsEnabled;
    const r = await ctx.client.post("/v1/access/check-email", { email: `probe-new-${Date.now()}@ke2e.kortix.test` });
    r.status(200);
    if (open) r.body().has("$.allowed", true).has("$.mode", "signup");
    else r.body().has("$.allowed", r.json<{ mode: string }>().mode === "signup");
  });
});

flow("ACC-3", { domain: "access", tags: [], routes: ["POST /v1/access/request-access"] }, async (ctx) => {
  // Public/unauthenticated early-access / waitlist submission — no principal,
  // no fixtures (the 'access' domain never provisions the matrix).
  await ctx.step("POST /v1/access/request-access (missing email) → 400", async () => {
    const r = await ctx.client.post("/v1/access/request-access", { company: "KE2E Labs" });
    r.status(400);
  });
  await ctx.step("POST /v1/access/request-access (invalid email) → 400", async () => {
    const r = await ctx.client.post("/v1/access/request-access", { email: "not-an-email" });
    r.status(400);
  });
  await ctx.step("POST /v1/access/request-access (valid, fresh throwaway email) → 200", async () => {
    const r = await ctx.client.post("/v1/access/request-access", {
      email: `ke2e-access-${Date.now()}@ke2e.kortix.test`,
      company: "KE2E Labs",
      useCase: "automated e2e coverage probe",
    });
    r.status(200).body().has("$.success", true).exists("$.message");
  });
});
