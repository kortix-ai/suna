import { describe, expect, test } from "bun:test";

import { shouldLoadProjectModelPicker } from "./provider-load-plan";

describe("shouldLoadProjectModelPicker", () => {
  test("starts the model-picker request while project detail is unresolved", () => {
    expect(
      shouldLoadProjectModelPicker({
        workspaceId: "project-1",
        projectModeKnown: false,
        projectGatewayEnabled: false,
      }),
    ).toBe(true);
  });

  test("keeps the model-picker request enabled for a gateway project", () => {
    expect(
      shouldLoadProjectModelPicker({
        workspaceId: "project-1",
        projectModeKnown: true,
        projectGatewayEnabled: true,
      }),
    ).toBe(true);
  });

  test("does not request the gateway model-picker for a known native project", () => {
    expect(
      shouldLoadProjectModelPicker({
        workspaceId: "project-1",
        projectModeKnown: true,
        projectGatewayEnabled: false,
      }),
    ).toBe(false);
  });

  test("does not request a project model-picker outside a project route", () => {
    expect(
      shouldLoadProjectModelPicker({
        workspaceId: null,
        projectModeKnown: true,
        projectGatewayEnabled: false,
      }),
    ).toBe(false);
  });
});
