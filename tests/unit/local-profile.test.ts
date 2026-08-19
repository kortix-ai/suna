import { describe, expect, it } from "vitest";
import type { RegisteredFlow } from "../src/core/flow";
import {
  localEnvironmentOverrides,
  localRunExitCode,
  localWebUrl,
  localWorkerCount,
  planLocalFlows,
} from "../src/core/local-profile";
import {
  LOCAL_TEST_PROFILE_HEADER,
  assertLoopbackHttpUrl,
  hasRequiredLocalSupabaseEnvironment,
  localApiUsesTestProfile,
  localMigrationPlan,
  localTopology,
  parseSupabaseEnvironment,
} from "../src/core/local-stack";
import { runExitCode } from "../src/core/result";

function registeredFlow(id: string, requires: RegisteredFlow["meta"]["requires"] = [], todo?: string): RegisteredFlow {
  return {
    id,
    meta: { domain: "test", requires, todo },
    fn: async () => {},
  };
}

describe("ke2e local profile", () => {
  it("targets the current worktree and local Supabase only", () => {
    expect(
      localEnvironmentOverrides({
        worktree: {
          ports: { web: 23600, api: 23608, gateway: 23690 },
        },
        supabase: {
          API_URL: "http://127.0.0.1:54321",
          DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
          ANON_KEY: "anon",
          SERVICE_ROLE_KEY: "service-role",
          JWT_SECRET: "jwt-secret",
        },
      }),
    ).toMatchObject({
      KE2E_TARGET: "local",
      KE2E_API_URL: "http://127.0.0.1:23608/v1",
      KE2E_BASE_URL: "http://localhost:23600",
      KE2E_GATEWAY_URL: "http://127.0.0.1:23690",
      KE2E_SUPABASE_URL: "http://127.0.0.1:54321",
      KE2E_DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      KE2E_SUPABASE_ANON_KEY: "anon",
      KE2E_SUPABASE_SERVICE_ROLE_KEY: "service-role",
      KE2E_LOCAL_BILLING_ENABLED: "1",
      KE2E_CAP_DAYTONA: "0",
      KE2E_CAP_MANAGED_GIT: "0",
      KE2E_CAP_MANAGED_GIT_PUSH: "0",
      KE2E_CAP_FUNDED: "0",
      KE2E_DEFAULT_FLOW_ATTEMPTS: "1",
    });
  });

  it("uses the Next development server's canonical localhost origin", () => {
    expect(localWebUrl(24000)).toBe("http://localhost:24000");
  });

  it("selects every local REST flow and explains every exclusion", () => {
    const local = registeredFlow("LOCAL-1", ["database"]);
    const sandbox = registeredFlow("SBX-1", ["daytona", "funded"]);
    const git = registeredFlow("GIT-1", ["managedGit"]);
    const unfinished = registeredFlow("TODO-1", [], "not implemented");

    const plan = planLocalFlows([sandbox, local, unfinished, git]);

    expect(plan.runnable).toEqual([local]);
    expect(plan.excluded).toEqual([
      { id: "SBX-1", reason: "external capabilities: daytona, funded" },
      { id: "TODO-1", reason: "todo: not implemented" },
      { id: "GIT-1", reason: "external capabilities: managedGit" },
    ]);
  });

  it("fails the local command on any selected skip, todo, or failure", () => {
    expect(localRunExitCode({ failed: 0, skipped: 0, todo: 0 })).toBe(0);
    expect(localRunExitCode({ failed: 1, skipped: 0, todo: 0 })).toBe(1);
    expect(localRunExitCode({ failed: 0, skipped: 1, todo: 0 })).toBe(1);
    expect(localRunExitCode({ failed: 0, skipped: 0, todo: 1 })).toBe(1);
  });

  it("fails a strict deployed run when any flow is skipped or remains todo", () => {
    expect(runExitCode({ failed: 0, skipped: 0, todo: 0 }, true)).toBe(0);
    expect(runExitCode({ failed: 1, skipped: 0, todo: 0 }, false)).toBe(1);
    expect(runExitCode({ failed: 0, skipped: 1, todo: 0 }, false)).toBe(0);
    expect(runExitCode({ failed: 0, skipped: 1, todo: 0 }, true)).toBe(1);
    expect(runExitCode({ failed: 0, skipped: 0, todo: 1 }, true)).toBe(1);
  });

  it("uses bounded CPU-aware concurrency", () => {
    expect(localWorkerCount(2)).toBe(4);
    expect(localWorkerCount(10)).toBe(10);
    expect(localWorkerCount(64)).toBe(16);
  });

  it("resolves primary and worktree ports without accepting a remote target", () => {
    expect(localTopology("/repo", null)).toMatchObject({
      root: "/repo",
      apiUrl: "http://127.0.0.1:8008/v1",
      worktreeName: null,
    });
    expect(
      localTopology(
        "/repo-feature",
        {
          path: "/repo-feature",
          branch: "feature",
          dbMode: "shared",
          ports: { web: 22000, api: 22008, gateway: 22090 },
        },
        { feature: { path: "/repo-feature" } },
      ),
    ).toMatchObject({
      apiUrl: "http://127.0.0.1:22008/v1",
      worktreeName: "feature",
    });
    expect(() =>
      localTopology("/repo-feature", {
        path: "/repo-feature",
        branch: "feature",
        ports: { web: 22000, api: 70_000, gateway: 22090 },
      }),
    ).toThrow("invalid local API port");
  });

  it("allows only unauthenticated loopback HTTP health targets", () => {
    expect(assertLoopbackHttpUrl("http://localhost:24000", "local web").hostname).toBe(
      "localhost",
    );
    expect(() => assertLoopbackHttpUrl("https://localhost:24000", "local web")).toThrow(
      "must use unauthenticated loopback HTTP",
    );
    expect(() => assertLoopbackHttpUrl("http://example.com", "local web")).toThrow(
      "must use unauthenticated loopback HTTP",
    );
    expect(() => assertLoopbackHttpUrl("http://user@127.0.0.1:24000", "local web")).toThrow(
      "must use unauthenticated loopback HTTP",
    );
  });

  it("parses the Supabase CLI environment without evaluating shell text", () => {
    expect(
      parseSupabaseEnvironment(
        'API_URL="http://127.0.0.1:54321"\nMAILPIT_URL="http://127.0.0.1:54324"\nANON_KEY="anon"\nSERVICE_ROLE_KEY="service"\nJWT_SECRET="jwt-secret"\nDB_URL="postgres://local"\n',
      ),
      ).toEqual({
        API_URL: "http://127.0.0.1:54321",
        MAILPIT_URL: "http://127.0.0.1:54324",
      ANON_KEY: "anon",
      SERVICE_ROLE_KEY: "service",
      JWT_SECRET: "jwt-secret",
      DB_URL: "postgres://local",
    });
  });

  it("accepts the minimum Supabase services required by the local runner", () => {
    expect(
      hasRequiredLocalSupabaseEnvironment({
        API_URL: "http://127.0.0.1:54321",
        DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        ANON_KEY: "anon",
        SERVICE_ROLE_KEY: "service",
      }),
    ).toBe(true);
    expect(
      hasRequiredLocalSupabaseEnvironment({
        API_URL: "http://127.0.0.1:54321",
        DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      }),
    ).toBe(false);
  });

  it("applies pending migrations to the resolved local database", () => {
    const topology = localTopology("/repo-feature", null);
    const plan = localMigrationPlan(topology, {
      DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    });

    expect(plan.command).toEqual(["pnpm", "--filter", "@kortix/db", "migrate:local"]);
    expect(plan.cwd).toBe("/repo-feature");
    expect(plan.env.DATABASE_URL).toBe(
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    );
  });

  it("rejects a local migration without a resolved database URL", () => {
    expect(() => localMigrationPlan(localTopology("/repo", null), {})).toThrow(
      "local Supabase environment is missing DB_URL",
    );
  });

  it("reuses only an API that proves the deterministic local test profile", async () => {
    const profiled = await localApiUsesTestProfile(
      "http://127.0.0.1:23608/v1",
      async () =>
        new Response("metrics disabled", {
          status: 404,
          headers: { [LOCAL_TEST_PROFILE_HEADER]: "1" },
        }),
    );
    const ordinaryDev = await localApiUsesTestProfile(
      "http://127.0.0.1:23608/v1",
      async () => new Response("metrics", { status: 200 }),
    );

    expect(profiled).toBe(true);
    expect(ordinaryDev).toBe(false);
  });
});
