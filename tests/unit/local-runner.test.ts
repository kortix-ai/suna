import { describe, expect, it } from "vitest";
import { buildLocalTestPlan, waitForLocalWeb } from "../src/core/local-runner";

describe("local test runner", () => {
  it("runs the REST flows, SDK, runner unit tests, and route coverage concurrently by default", () => {
    const plan = buildLocalTestPlan([]);

    expect(plan.mode).toBe("core");
    expect(plan.lanes.map((lane) => lane.name)).toEqual([
      "api-cli-flows",
      "sdk",
      "flow-runner-unit",
      "route-coverage",
      "worktree-unit",
    ]);
  });

  it("runs one filtered flow without paying the SDK or unit-test cost", () => {
    const plan = buildLocalTestPlan(["--id", "ACC-4"]);

    expect(plan.mode).toBe("flows");
    expect(plan.lanes).toHaveLength(1);
    expect(plan.lanes[0]?.command.slice(-2)).toEqual(["--id", "ACC-4"]);
  });

  it("adds every app and package test plus publish checks without running SDK twice", () => {
    const plan = buildLocalTestPlan(["--full"]);

    expect(plan.mode).toBe("full");
    expect(plan.lanes.map((lane) => lane.name)).toEqual([
      "api-cli-flows",
      "flow-runner-unit",
      "route-coverage",
      "worktree-unit",
      "browser",
      "package-quality",
    ]);
    expect(plan.lanes.at(-1)?.command).toEqual([
      "bun",
      "tests/bin/package-quality.ts",
    ]);
    expect(plan.stages.map((stage) => stage.map((lane) => lane.name))).toEqual([
      [
        "api-cli-flows",
        "flow-runner-unit",
        "route-coverage",
        "worktree-unit",
        "browser",
      ],
      ["package-quality"],
    ]);
    expect(plan.stages[0]?.[0]?.command.slice(-2)).toEqual(["--api-workers", "4"]);
    expect(plan.lanes.find((lane) => lane.name === "browser")?.env).toEqual({
      E2E_BROWSER_WORKERS: "2",
    });
  });

  it("runs browser journeys through the same root command", () => {
    const plan = buildLocalTestPlan(["--browser-only"]);

    expect(plan.mode).toBe("browser");
    expect(plan.lanes).toHaveLength(1);
    expect(plan.lanes[0]?.name).toBe("browser");
    expect(plan.lanes[0]).toEqual({
      name: "browser",
      command: ["bun", "run", "test:browser"],
      cwd: "tests",
    });
  });

  it("rejects conflicting modes", () => {
    expect(() => buildLocalTestPlan(["--full", "--sdk-only"])).toThrow(
      "choose only one",
    );
  });

  it("retries a cold local web route until it is ready", async () => {
    let attempts = 0;
    const sleeps: number[] = [];

    await waitForLocalWeb("http://127.0.0.1:24000", {
      timeoutMs: 1_000,
      probe: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("compiling");
        return new Response(null, { status: 200 });
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(attempts).toBe(3);
    expect(sleeps).toEqual([250, 250]);
  });
});
