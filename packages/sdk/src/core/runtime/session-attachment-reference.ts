const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const REFERENCE = new RegExp(`^/projects/(${UUID})/sessions/(${UUID})/attachments/([a-f0-9]{64})$`);

export function parseSessionAttachmentReference(value: unknown) {
  const match = typeof value === 'string' ? REFERENCE.exec(value) : null;
  return match ? { projectId: match[1]!, sessionId: match[2]!, sha256: match[3]! } : null;
}

export function sessionAttachmentReference(projectId: string, sessionId: string, sha256: string): string | null {
  const ref = `/projects/${projectId}/sessions/${sessionId}/attachments/${sha256}`;
  return parseSessionAttachmentReference(ref) ? ref : null;
}
