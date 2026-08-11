import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

describe("admin Workspace route compatibility", () => {
  test("publishes the canonical Workspace route", () => {
    expect(source).toContain('path: "/api/workspaces"');
    expect(source).toContain("workspaces: list");
  });

  test("keeps the legacy Project route as deprecated compatibility", () => {
    expect(source).toContain('path: "/api/projects"');
    expect(source).toContain("deprecated: true");
    expect(source).toContain("projects: list");
  });

  test("publishes canonical and deprecated per-account inventory routes", () => {
    expect(source).toContain('path: "/api/accounts/{id}/workspaces"');
    expect(source).toContain('path: "/api/accounts/{id}/projects"');
    expect(source).toContain('summary: "List workspaces owned by an account"');
    expect(source).toContain('summary: "List workspaces owned by an account (deprecated Project alias)"');
    expect(source).toContain("legacyProjectResponse ? { projects: list } : { workspaces: list }");
  });
});
