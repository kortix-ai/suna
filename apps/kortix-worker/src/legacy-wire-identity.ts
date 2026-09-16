import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { JournalLogItem, SessionLogItem } from "./session-store.ts";
import { mintRootId, WIRE_MESSAGE_ID } from "./wire-message-id.ts";

export const LEGACY_WIRE_IDENTITY_STREAM = "kortix.pi.legacy-wire-identity.v1";

interface LegacyWireIdentity {
  sessionId: string;
  entryId: string;
  fingerprint: string;
  messageId: string;
  parentMessageId?: string;
  createdAt: number;
  partIds: string[];
}

function fingerprint(value: unknown): string {
  const sorted = (item: any): any => {
    if (Array.isArray(item)) return item.map(sorted);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, sorted(item[key])]),
      );
    }
    return item;
  };
  return createHash("sha256")
    .update(JSON.stringify(sorted(value)))
    .digest("hex");
}

function parts(message: any): any[] {
  if (!Array.isArray(message?.content))
    throw new Error("legacy message content must be an array");
  return message.content.flatMap((block: any) => {
    if (block?.type === "text")
      return block.text ? [{ type: "text", text: block.text }] : [];
    if (block?.type === "thinking")
      return block.thinking
        ? [{ type: "reasoning", text: block.thinking }]
        : [];
    if (block?.type === "toolCall" && block.name) {
      return [
        {
          type: "tool",
          callID: block.id,
          tool: block.name,
          input: block.arguments,
        },
      ];
    }
    throw new Error(
      "legacy identity capture does not support this message block",
    );
  });
}

/** Capture an idle legacy worker's visible identities before that process stops. */
export function captureLegacyWireIdentities(
  sessionId: string,
  entries: readonly any[],
  messages: readonly any[],
): JournalLogItem[] {
  const source = entries
    .filter(
      (entry) =>
        entry.type === "message" && entry.message?.role !== "toolResult",
    )
    .toSorted((a, b) => a.seq - b.seq);
  if (source.length !== messages.length)
    throw new Error("legacy transcript message count changed");
  const sessionID = mintRootId(sessionId);
  let previousId = "";
  let parentMessageId: string | undefined;
  const seenParts = new Set<string>();
  const identities = source.map((entry, index) => {
    const native = entry.message;
    const wire = messages[index];
    if (
      !entry.id ||
      !["user", "assistant"].includes(native.role) ||
      native.kortixWireMessageId
    ) {
      throw new Error(
        "legacy capture requires unidentified user and assistant entries",
      );
    }
    if (
      !wire?.info ||
      wire.info.role !== native.role ||
      wire.info.sessionID !== sessionID ||
      !WIRE_MESSAGE_ID.test(wire.info.id) ||
      wire.info.id <= previousId
    ) {
      throw new Error(
        "legacy transcript identity or order does not match the source",
      );
    }
    const createdAt = wire.info.time?.created;
    if (
      typeof createdAt !== "number" ||
      !Number.isFinite(createdAt) ||
      createdAt < 0
    ) {
      throw new Error("legacy message creation time is invalid");
    }
    const expected = parts(native);
    if (!Array.isArray(wire.parts) || wire.parts.length !== expected.length) {
      throw new Error("legacy transcript part count changed");
    }
    const partIds = wire.parts.map((part: any, partIndex: number) => {
      const expectedPart = expected[partIndex];
      if (
        typeof part.id !== "string" ||
        !part.id ||
        seenParts.has(part.id) ||
        part.messageID !== wire.info.id ||
        part.sessionID !== sessionID ||
        part.type !== expectedPart.type
      ) {
        throw new Error("legacy part identity does not match its source");
      }
      if (part.type === "tool") {
        if (
          part.callID !== part.id ||
          part.tool !== expectedPart.tool ||
          !isDeepStrictEqual(part.state?.input, expectedPart.input) ||
          !["completed", "error"].includes(part.state?.status)
        ) {
          throw new Error(
            "legacy tool is unsettled or does not match its source",
          );
        }
      } else if (part.text !== expectedPart.text) {
        throw new Error("legacy transcript content changed");
      }
      seenParts.add(part.id);
      return part.id;
    });
    if (native.role === "user") parentMessageId = wire.info.id;
    else if (
      !parentMessageId ||
      (wire.info.parentID && wire.info.parentID !== parentMessageId)
    ) {
      throw new Error("legacy assistant parent does not match its source");
    }
    previousId = wire.info.id;
    return {
      sessionId,
      entryId: entry.id,
      fingerprint: fingerprint(native),
      messageId: wire.info.id,
      createdAt,
      partIds,
      ...(native.role === "assistant" ? { parentMessageId } : {}),
    };
  });
  return [
    {
      kind: "journal",
      stream: LEGACY_WIRE_IDENTITY_STREAM,
      record: { identities },
    },
  ];
}

/** Replay checkpoints as metadata overlays; the original log entries remain unchanged. */
export function applyLegacyWireIdentities(
  items: readonly SessionLogItem[],
  sessionId: string,
): SessionLogItem[] {
  if (
    !items.some(
      (item) =>
        item.kind === "journal" && item.stream === LEGACY_WIRE_IDENTITY_STREAM,
    )
  ) {
    return [...items];
  }
  const records = new Map<string, LegacyWireIdentity>();
  const entries = new Map(
    items
      .filter((item) => item.kind === "entry")
      .map((item) => [item.entry.id, item.entry]),
  );
  const ids = new Set<string>();
  const partIds = new Set<string>();
  for (const item of items) {
    if (item.kind !== "journal" || item.stream !== LEGACY_WIRE_IDENTITY_STREAM)
      continue;
    if (!Array.isArray(item.record.identities))
      throw new Error("legacy checkpoint identities must be an array");
    for (const record of item.record
      .identities as unknown as LegacyWireIdentity[]) {
      const source = entries.get(record.entryId)?.message;
      if (
        record.sessionId !== sessionId ||
        !source ||
        !["user", "assistant"].includes(source.role) ||
        source.kortixWireMessageId ||
        record.fingerprint !== fingerprint(source) ||
        !WIRE_MESSAGE_ID.test(record.messageId) ||
        !Number.isFinite(record.createdAt) ||
        record.createdAt < 0 ||
        !Array.isArray(record.partIds) ||
        record.partIds.length !== parts(source).length ||
        record.partIds.some((id) => typeof id !== "string" || !id) ||
        (source.role === "assistant" &&
          (!record.parentMessageId ||
            !WIRE_MESSAGE_ID.test(record.parentMessageId))) ||
        (source.role === "user" && record.parentMessageId !== undefined)
      ) {
        throw new Error("legacy identity checkpoint does not match its source");
      }
      const existing = records.get(record.entryId);
      if (existing) {
        if (!isDeepStrictEqual(existing, record))
          throw new Error("conflicting legacy identity checkpoints");
        continue;
      }
      if (
        ids.has(record.messageId) ||
        record.partIds.some((id) => partIds.has(id)) ||
        new Set(record.partIds).size !== record.partIds.length
      ) {
        throw new Error(
          "legacy identity checkpoint reuses a message or part ID",
        );
      }
      ids.add(record.messageId);
      for (const id of record.partIds) partIds.add(id);
      records.set(record.entryId, structuredClone(record));
    }
  }
  const users = new Set(
    [...records.values()]
      .filter((record) => entries.get(record.entryId).message.role === "user")
      .map((record) => record.messageId),
  );
  for (const record of records.values()) {
    if (
      record.parentMessageId &&
      (!users.has(record.parentMessageId) ||
        record.parentMessageId >= record.messageId)
    ) {
      throw new Error(
        "legacy identity checkpoint has an invalid assistant parent",
      );
    }
  }
  for (const entry of entries.values()) {
    if (
      entry.message?.kortixWireMessageId &&
      ids.has(entry.message.kortixWireMessageId)
    ) {
      throw new Error(
        "legacy identity checkpoint conflicts with a native message ID",
      );
    }
  }
  return items.map((item) => {
    if (item.kind !== "entry") return item;
    const record = records.get(item.entry.id);
    if (!record) return item;
    return {
      ...item,
      entry: {
        ...item.entry,
        message: {
          ...item.entry.message,
          kortixWireMessageId: record.messageId,
          kortixWireCreatedAt: record.createdAt,
          kortixWirePartIds: record.partIds,
          ...(record.parentMessageId
            ? { kortixParentMessageId: record.parentMessageId }
            : {}),
        },
      },
    };
  });
}
