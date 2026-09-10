import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  readSessionAttachment,
  validateAttachmentIdentity,
} from "./session-attachment-input";

const bytes = Buffer.from([0, 255, 10, 128]);
const sha256 = createHash("sha256").update(bytes).digest("hex");

describe("immutable session attachment admission", () => {
  test("preserves binary bytes and verifies the content address", async () => {
    const result = await readSessionAttachment(
      new Request("http://localhost", {
        method: "PUT",
        body: bytes,
      }),
    );
    expect(result).toEqual(bytes);
    expect(validateAttachmentIdentity(sha256, "image/png", result)).toEqual({
      sha256,
      contentType: "image/png",
    });
  });
  test("rejects malformed hashes, mismatched bytes and unsafe MIME types", () => {
    expect(() =>
      validateAttachmentIdentity("../secret", "image/png", bytes),
    ).toThrow("sha256");
    expect(() =>
      validateAttachmentIdentity("a".repeat(64), "image/png", bytes),
    ).toThrow("does not match");
    for (const contentType of [
      "",
      "text/html\r\nx-test: 1",
      "image/png; charset=utf8",
      "text /plain",
    ]) {
      expect(() =>
        validateAttachmentIdentity(sha256, contentType, bytes),
      ).toThrow("content-type");
    }
    expect(
      validateAttachmentIdentity(sha256, "IMAGE/PNG", bytes).contentType,
    ).toBe("image/png");
  });
  test("rejects declared oversized uploads before reading their body", async () => {
    let pulls = 0;
    const request = new Request("http://localhost", {
      method: "PUT",
      headers: { "content-length": "8388609" },
      body: new ReadableStream(
        {
          pull() {
            pulls++;
          },
        },
        { highWaterMark: 0 },
      ),
      duplex: "half",
    } as RequestInit);
    await expect(readSessionAttachment(request)).rejects.toMatchObject({
      status: 413,
    });
    expect(pulls).toBe(0);
  });
  test("bounds chunked uploads even without a content-length header and cancels the stream", async () => {
    let cancelled = false;
    const request = new Request("http://localhost", {
      method: "PUT",
      body: new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
        cancel() {
          cancelled = true;
        },
      }),
      duplex: "half",
    } as RequestInit);
    await expect(readSessionAttachment(request)).rejects.toMatchObject({
      status: 413,
    });
    expect(cancelled).toBe(true);
  });
  test("accepts the exact limit and rejects empty attachments", async () => {
    expect(
      (
        await readSessionAttachment(
          new Request("http://localhost", {
            method: "PUT",
            body: new Uint8Array(8 * 1024 * 1024),
          }),
        )
      ).length,
    ).toBe(8 * 1024 * 1024);
    await expect(
      readSessionAttachment(new Request("http://localhost", { method: "PUT" })),
    ).rejects.toMatchObject({ status: 400 });
  });
});
