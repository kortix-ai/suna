import { describe, expect, test } from "bun:test";

import { workspaceCompatibilityRoute } from "./check-coverage";

describe("workspaceCompatibilityRoute", () => {
  test("maps a Project flow declaration onto its canonical Workspace route", () => {
    expect(
      workspaceCompatibilityRoute(
        "GET",
        "/v1/projects/:workspaceId/sessions/:sessionId",
      ),
    ).toBe("GET /v1/workspaces/:*/sessions/:*");
  });

  test("does not alias unrelated Project strings", () => {
    expect(
      workspaceCompatibilityRoute("GET", "/v1/projects-search"),
    ).toBeNull();
  });
});
