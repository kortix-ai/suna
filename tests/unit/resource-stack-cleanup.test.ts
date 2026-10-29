import { expect, test } from "vitest";
import type { Client } from "../src/core/client";
import { ResourceStack } from "../src/fixtures/registry";

test("fixture cleanup attempts later resources after one disposal fails", async () => {
  const attempted: string[] = [];
  const stack = new ResourceStack({} as Client, async (id) => {
    attempted.push(id);
    if (id === "synthetic-failed-project")
      throw new Error("Injected disposal failure");
  });
  stack.push("database-project", "synthetic-later-project");
  stack.push("local-git", "synthetic-repository", {
    dispose: async () => {
      attempted.push("synthetic-repository");
    },
  });
  stack.push("database-project", "synthetic-failed-project");
  await stack.teardown();
  expect(attempted).toEqual([
    "synthetic-failed-project",
    "synthetic-repository",
    "synthetic-later-project",
  ]);
});
