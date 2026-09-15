import { expect, test } from "bun:test";
import {
  captureLegacyWireIdentities,
  applyLegacyWireIdentities,
} from "./legacy-wire-identity.ts";
import { mintRootId } from "./runtime-surface.ts";
import type { SessionLogItem } from "./session-store.ts";

function fixture() {
  const sessionId = "legacy-history";
  const sessionID = mintRootId(sessionId);
  const ids = [
    "msg_000000000010aaaaaaaaaaaaaa",
    "msg_000000000020bbbbbbbbbbbbbb",
  ];
  const entries = ["user", "assistant"].map((role, index) => ({
    id: `entry-${index}`,
    type: "message",
    seq: index,
    message: {
      role,
      content: [{ type: "text", text: role + " text" }],
      timestamp: 20 + index,
    },
  }));
  const messages = entries.map((entry, index) => ({
    info: {
      id: ids[index]!,
      role: entry.message.role,
      sessionID,
      time: { created: 10 + index },
    },
    parts: [
      {
        id: `old-part-${index}`,
        messageID: ids[index]!,
        sessionID,
        type: "text",
        text: entry.message.content[0]!.text,
      },
    ],
  }));
  const items = entries.map(
    (entry) => ({ kind: "entry", lane: "main", entry }) as SessionLogItem,
  );
  return { sessionId, entries, messages, items };
}

test("a captured checkpoint binds original message and part IDs without rewriting native entries", () => {
  const f = fixture();
  const before = structuredClone(f.items);
  const records = captureLegacyWireIdentities(
    f.sessionId,
    f.entries,
    f.messages,
  );
  expect(records).toHaveLength(1);
  const replay = applyLegacyWireIdentities(
    [...f.items, ...records, ...records],
    f.sessionId,
  );
  const first = (replay[0] as any).entry.message;
  const second = (replay[1] as any).entry.message;
  expect(first.kortixWireMessageId).toBe(f.messages[0]!.info.id);
  expect(first.kortixWirePartIds).toEqual(["old-part-0"]);
  expect(first.kortixWireCreatedAt).toBe(10);
  expect(second.kortixParentMessageId).toBe(f.messages[0]!.info.id);
  expect(second.content).toEqual(f.entries[1]!.message.content);
  expect(f.items).toEqual(before);
});

test("checkpoint fingerprints survive JSON object-key reordering", () => {
  const f = fixture();
  const records = captureLegacyWireIdentities(
    f.sessionId,
    f.entries,
    f.messages,
  );
  (f.items[0] as any).entry.message = {
    timestamp: 20,
    content: [{ text: "user text", type: "text" }],
    role: "user",
  };
  expect(() =>
    applyLegacyWireIdentities([...f.items, ...records], f.sessionId),
  ).not.toThrow();
});

test.each([
  "content",
  "role",
  "session",
  "message-order",
  "part-owner",
  "missing-message",
])("capture rejects mismatched live history: %s", (kind) => {
  const f = fixture();
  if (kind === "content") f.messages[0]!.parts[0]!.text = "Wrong input";
  if (kind === "role") f.messages[0]!.info.role = "assistant";
  if (kind === "session")
    f.messages[0]!.info.sessionID = mintRootId("another-session");
  if (kind === "message-order") f.messages.reverse();
  if (kind === "part-owner")
    f.messages[0]!.parts[0]!.messageID = f.messages[1]!.info.id;
  if (kind === "missing-message") f.messages.pop();
  expect(() =>
    captureLegacyWireIdentities(f.sessionId, f.entries, f.messages),
  ).toThrow();
});

test.each([
  "source-content",
  "source-entry",
  "session",
  "duplicate-id",
  "conflicting-checkpoint",
  "part-count",
  "existing-identity",
])("replay rejects a stale or conflicting checkpoint: %s", (kind) => {
  const f = fixture();
  const records = captureLegacyWireIdentities(
    f.sessionId,
    f.entries,
    f.messages,
  );
  if (kind === "source-content")
    (f.items[0] as any).entry.message.content[0].text = "Changed after capture";
  if (kind === "source-entry") f.items.shift();
  if (kind === "session")
    (records[0]!.record.identities as any[])[0].sessionId = "wrong-session";
  if (kind === "duplicate-id")
    (records[0]!.record.identities as any[])[1].messageId =
      f.messages[0]!.info.id;
  if (kind === "conflicting-checkpoint")
    records.push({
      ...records[0]!,
      record: {
        identities: [
          { ...(records[0]!.record.identities as any[])[0], createdAt: 99 },
        ],
      },
    });
  if (kind === "part-count")
    (records[0]!.record.identities as any[])[0].partIds = [];
  if (kind === "existing-identity")
    (f.items[0] as any).entry.message.kortixWireMessageId =
      f.messages[1]!.info.id;
  expect(() =>
    applyLegacyWireIdentities([...f.items, ...records], f.sessionId),
  ).toThrow();
});

test("capture accepts the adapter tool-call identity and rejects an unsettled tool", () => {
  const f = fixture();
  const native = f.entries[1]!.message as any;
  native.content = [
    {
      type: "toolCall",
      id: "provider-call-id",
      name: "read",
      arguments: { path: "note.txt" },
    },
  ];
  const part = {
    id: "old-tool-part",
    callID: "old-tool-part",
    messageID: f.messages[1]!.info.id,
    sessionID: mintRootId(f.sessionId),
    type: "tool",
    tool: "read",
    state: {
      status: "completed",
      input: { path: "note.txt" },
      output: "Stored text",
    },
  };
  f.messages[1]!.parts = [part as any];
  expect(
    captureLegacyWireIdentities(f.sessionId, f.entries, f.messages),
  ).toHaveLength(1);
  part.state.status = "running";
  expect(() =>
    captureLegacyWireIdentities(f.sessionId, f.entries, f.messages),
  ).toThrow("unsettled");
});
