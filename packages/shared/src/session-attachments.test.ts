import { expect, test } from "bun:test";
import {
  sessionAttachmentRef,
  parseSessionAttachmentRef,
} from "./session-attachments";
const scope = {
  projectId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  attachmentId: "33333333-3333-4333-8333-333333333333",
};
test("attachment references retain their complete session scope", () => {
  expect(parseSessionAttachmentRef(sessionAttachmentRef(scope))).toEqual(scope);
});
test("rejects URLs, traversal, credentials, queries and fragments", () => {
  for (const value of [
    "https://outside.test",
    "kortix-attachment://a/../b",
    `${sessionAttachmentRef(scope)}?url=x`,
    `${sessionAttachmentRef(scope)}#x`,
    `kortix-attachment://user@${scope.projectId}/${scope.sessionId}/${scope.attachmentId}`,
  ]) {
    expect(parseSessionAttachmentRef(value)).toBeNull();
  }
});
