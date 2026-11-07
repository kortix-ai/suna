/**
 * The test runner refuses to migrate the SHARED primary database when the tree
 * carries migrations origin/dev does not have (learning 2026-11-06T040313Z).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  branchOnlyMigrations,
  SHARED_DB_MIGRATE_OVERRIDE,
  sharedDatabaseMigrationRefusal,
} from "../src/core/local-stack";

const SHARED = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const BRANCH_DB = "postgresql://postgres:postgres@127.0.0.1:54322/kortix_wt_feature";
const MIGRATION = "packages/db/migrations/20991231000000000_branch_only.sql";
const shared = { marker: null, worktreeName: "feature" } as const;
const marker = (dbMode: "shared" | "branch" | "isolated") =>
  ({ marker: { dbMode } as never, worktreeName: "feature" });

describe("sharedDatabaseMigrationRefusal", () => {
  it("refuses a shared database when the tree adds a migration, and names --db", () => {
    for (const topology of [shared, marker("shared")]) {
      const refusal = sharedDatabaseMigrationRefusal({ topology, dbUrl: SHARED, branchOnly: [MIGRATION], env: {} });
      expect(refusal).toContain("refused");
      expect(refusal).toContain(MIGRATION);
      expect(refusal).toContain("pnpm worktree create --name feature --db");
      expect(refusal).not.toContain("postgres:postgres@");
    }
  });

  it("migrates a worktree's own database, a tree equal to origin/dev, CI and an explicit override", () => {
    const refuse = (over: Partial<Parameters<typeof sharedDatabaseMigrationRefusal>[0]>) =>
      sharedDatabaseMigrationRefusal({ topology: shared, dbUrl: SHARED, branchOnly: [MIGRATION], env: {}, ...over });
    expect(refuse({ topology: marker("branch"), dbUrl: BRANCH_DB })).toBeNull();
    expect(refuse({ topology: marker("isolated") })).toBeNull();
    expect(refuse({ dbUrl: BRANCH_DB })).toBeNull();
    expect(refuse({ branchOnly: [] })).toBeNull();
    expect(refuse({ branchOnly: null })).toBeNull();
    expect(refuse({ env: { CI: "true" } })).toBeNull();
    expect(refuse({ env: { [SHARED_DB_MIGRATE_OVERRIDE]: "1" } })).toBeNull();
    expect(refuse({ env: { CI: "false" } })).not.toBeNull();
  });
});

describe("branchOnlyMigrations", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function repo(): string {
    const root = mkdtempSync(join(tmpdir(), "shared-db-guard-"));
    roots.push(root);
    const git = (...args: string[]) => {
      const out = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      if (out.status !== 0) throw new Error(out.stderr);
    };
    git("init", "-q");
    git("config", "user.email", "guard@example.test");
    git("config", "user.name", "guard");
    mkdirSync(join(root, "packages/db/migrations"), { recursive: true });
    writeFileSync(join(root, "packages/db/migrations/20260101000000000_base.sql"), "select 1;\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    git("update-ref", "refs/remotes/origin/dev", "HEAD");
    return root;
  }

  it("lists committed, modified and untracked migration files that origin/dev lacks", () => {
    const root = repo();
    expect(branchOnlyMigrations(root)).toEqual([]);
    writeFileSync(join(root, MIGRATION), "select 2;\n");
    expect(branchOnlyMigrations(root)).toEqual([MIGRATION]);
    spawnSync("git", ["add", "."], { cwd: root });
    spawnSync("git", ["commit", "-q", "-m", "branch"], { cwd: root });
    writeFileSync(join(root, "packages/db/migrations/20260101000000000_base.sql"), "select 3;\n");
    expect(branchOnlyMigrations(root)).toEqual([
      "packages/db/migrations/20260101000000000_base.sql",
      MIGRATION,
    ]);
  });

  it("answers null without origin/dev", () => {
    const root = repo();
    spawnSync("git", ["update-ref", "-d", "refs/remotes/origin/dev"], { cwd: root });
    expect(branchOnlyMigrations(root)).toBeNull();
  });
});
