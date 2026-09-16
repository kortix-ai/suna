import { expect, test } from "bun:test";
import { PermissionBroker } from "./permission-broker.ts";

test("tool visibility honors compiled rules, session replacement, edit aliases, and pattern exceptions", async () => {
  const broker = new PermissionBroker({
    sessionId: "tools",
    publish: () => {},
    permission: { bash: "deny", read: { "*.env": "deny" } },
  });
  expect(broker.toolEnabled("bash")).toBe(false);
  expect(broker.toolEnabled("read")).toBe(true);
  broker.setToolControls({ bash: true, edit: false });
  expect(broker.toolEnabled("bash")).toBe(true);
  expect(broker.toolEnabled("write")).toBe(false);
  expect(broker.toolEnabled("edit")).toBe(false);
  await expect(
    broker.authorize({
      permission: "edit",
      patterns: ["file.txt"],
      always: ["*"],
      metadata: {},
    }),
  ).rejects.toThrow("permission denied");
  broker.setToolControls({ "*": false, question: true });
  expect(broker.toolEnabled("bash")).toBe(false);
  expect(broker.toolEnabled("question")).toBe(true);
  broker.setToolControls({ write: false });
  expect(broker.toolEnabled("write")).toBe(true);
  expect(broker.toolEnabled("bash")).toBe(false);
});

test("a saved always grant cannot expose a tool hidden by current session controls", () => {
  const broker = new PermissionBroker({
    sessionId: "tools",
    publish: () => {},
    approved: [{ requestId: "p1", permission: "bash", patterns: ["*"] }],
  });
  broker.setToolControls({ bash: false });
  expect(broker.toolEnabled("bash")).toBe(false);
});
