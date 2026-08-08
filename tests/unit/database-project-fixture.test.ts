import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/core/env";
import {
  type OpenProjectDb,
  createDatabaseProject,
  deleteDatabaseProject,
} from "../src/fixtures/database-project";
import { createLocalGitRepository } from "../src/fixtures/local-git";
import { buildWorld } from "../src/fixtures/world";

function env(overrides: Partial<Env> = {}): Env {
  return {
    apiUrl: "https://staging-api.kortix.com/v1",
    baseUrl: "https://staging.kortix.com",
    gatewayUrl: "https://gateway-staging.kortix.com",
    supabaseUrl: "https://supabase.example",
    supabaseAnonKey: "anon",
    supabaseServiceRoleKey: "service",
    databaseUrl: "postgres://staging.example/kortix",
    ownerEmail: null,
    ownerPassword: null,
    adminToken: null,
    internalServiceKey: null,
    stripeSecretKey: null,
    stripeWebhookSecret: null,
    liveConfirm: "ci",
    target: "staging",
    capabilities: {
      daytona: true,
      managedGit: true,
      managedGitPush: false,
      stripe: false,
      supabaseAdmin: true,
      database: true,
      admin: false,
      internalCron: false,
      funded: true,
    },
    testEmailDomain: "ke2e.kortix.test",
    ...overrides,
  };
}

function database() {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const end = vi.fn().mockResolvedValue(undefined);
  const open: OpenProjectDb = vi.fn().mockResolvedValue({ query, end });
  return { open, query, end };
}

describe("database-only project fixture", () => {
  it("reports zero structured fixture counts for a public-only run", async () => {
    const world = await buildWorld(env(), [
      {
        id: "SYS-TEST",
        meta: { domain: "system", routes: [] },
        fn: async () => {},
      },
    ]);

    expect(world.fixtureStats()).toEqual({
      databaseProjectCount: 0,
      managedProjectCount: 0,
    });
  });

  it("creates an isolated project row and manager grant without a Git provider call", async () => {
    const db = database();

    const project = await createDatabaseProject(
      env(),
      {
        accountId: "11111111-1111-4111-8111-111111111111",
        userId: "22222222-2222-4222-8222-222222222222",
        name: "e2e-project",
      },
      db.open,
    );

    expect(project.name).toBe("e2e-project");
    expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.query).toHaveBeenCalledOnce();
    expect(db.query.mock.calls[0][0]).toContain("INSERT INTO kortix.projects");
    expect(db.query.mock.calls[0][0]).toContain(
      "INSERT INTO kortix.project_members",
    );
    expect(db.query.mock.calls[0][1]).toEqual([
      project.id,
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "e2e-project",
      null,
      JSON.stringify({
        ke2e: { database_only: true },
        experimental: { apps: true },
        onboarding_completed_at: "2026-01-01T00:00:00.000Z",
      }),
    ]);
    expect(db.end).toHaveBeenCalledOnce();
  });

  it("accepts a local Git remote for black-box repository flows", async () => {
    const db = database();

    const project = await createDatabaseProject(
      env({ target: "local" }),
      {
        accountId: "11111111-1111-4111-8111-111111111111",
        userId: "22222222-2222-4222-8222-222222222222",
        name: "local-project",
        repoUrl: "/tmp/ke2e-local.git",
      },
      db.open,
    );

    expect(db.query.mock.calls[0][1]).toEqual([
      project.id,
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "local-project",
      "/tmp/ke2e-local.git",
      JSON.stringify({
        ke2e: { database_only: true },
        experimental: { apps: true },
        onboarding_completed_at: "2026-01-01T00:00:00.000Z",
      }),
    ]);
  });

  it("can create a project with Apps disabled for the opt-in journey", async () => {
    const db = database();

    await createDatabaseProject(
      env({ target: "local" }),
      {
        accountId: "11111111-1111-4111-8111-111111111111",
        userId: "22222222-2222-4222-8222-222222222222",
        name: "apps-opt-in",
        appsEnabled: false,
      },
      db.open,
    );

    expect(JSON.parse(db.query.mock.calls[0][1][5])).toMatchObject({
      experimental: { apps: false },
    });
  });

  it("creates a seeded local bare repository without a network dependency", async () => {
    const repository = await createLocalGitRepository("local-fixture");
    try {
      const head = spawnSync(
        "git",
        ["--git-dir", repository.repoUrl, "rev-parse", "refs/heads/main"],
        { encoding: "utf8" },
      );
      expect(head.status).toBe(0);
      expect(head.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
      const manifest = spawnSync(
        "git",
        ["--git-dir", repository.repoUrl, "show", "main:kortix.yaml"],
        { encoding: "utf8" },
      );
      expect(manifest.status).toBe(0);
      expect(manifest.stdout).toContain("kortix_version: 2");
      expect(manifest.stdout).toContain("default_agent: kortix");
    } finally {
      await repository.dispose();
    }
  });

  it("deletes the project row directly and relies on database cascades", async () => {
    const db = database();

    await deleteDatabaseProject(
      env(),
      "33333333-3333-4333-8333-333333333333",
      db.open,
    );

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM kortix.projects"),
      ["33333333-3333-4333-8333-333333333333"],
    );
    expect(db.end).toHaveBeenCalledOnce();
  });

  it("rejects database-only fixture writes against production", async () => {
    const db = database();

    await expect(
      createDatabaseProject(
        env({ target: "prod" }),
        {
          accountId: "11111111-1111-4111-8111-111111111111",
          userId: "22222222-2222-4222-8222-222222222222",
          name: "forbidden",
        },
        db.open,
      ),
    ).rejects.toThrow(
      "refusing to create a database-only project against production",
    );
    expect(db.open).not.toHaveBeenCalled();
  });

  it("requires KE2E_DATABASE_URL", async () => {
    const db = database();

    await expect(
      createDatabaseProject(
        env({ databaseUrl: null }),
        {
          accountId: "11111111-1111-4111-8111-111111111111",
          userId: "22222222-2222-4222-8222-222222222222",
          name: "missing-db",
        },
        db.open,
      ),
    ).rejects.toThrow("KE2E_DATABASE_URL is required");
    expect(db.open).not.toHaveBeenCalled();
  });
});

describe("managed Git fixture selection", () => {
  it("runs CONN-5 last against the shared managed repository", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../src/flows/connectors.flow.ts"),
      "utf8",
    );
    const start = source.indexOf("'CONN-5'");
    const end = source.indexOf("\nflow(", start);
    const conn5 = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(conn5).toContain("global: true");
    expect(conn5).toContain("ctx.fixtures.sharedProject()");
    expect(conn5).not.toContain("ctx.fixtures.project()");
  });

  it("bounds stale-user GC with parallel workers", () => {
    const gc = readFileSync(
      resolve(import.meta.dirname, "../src/fixtures/gc.ts"),
      "utf8",
    );

    expect(gc).toContain("KE2E_GC_WORKERS");
    expect(gc).toContain("mapWithConcurrency(stale, workers");
    expect(gc).toContain("if (env.databaseUrl) return listTestUsersViaDb(env)");
    expect(gc).toContain("ssl: local ? false : true");
  });
});
