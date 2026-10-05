export const MAX_SESSION_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export interface SessionAttachmentScope {
  projectId: string;
  sessionId: string;
  attachmentId: string;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const REFERENCE = new RegExp(
  `^kortix-attachment://(${UUID})/(${UUID})/(${UUID})$`,
);

export function parseSessionAttachmentRef(
  value: unknown,
): SessionAttachmentScope | null {
  if (typeof value !== "string") return null;
  const match = REFERENCE.exec(value);
  return match
    ? { projectId: match[1]!, sessionId: match[2]!, attachmentId: match[3]! }
    : null;
}

export function sessionAttachmentRef(scope: SessionAttachmentScope): string {
  const ref = `kortix-attachment://${scope.projectId}/${scope.sessionId}/${scope.attachmentId}`;
  if (!parseSessionAttachmentRef(ref))
    throw new Error("Invalid attachment reference");
  return ref;
}
