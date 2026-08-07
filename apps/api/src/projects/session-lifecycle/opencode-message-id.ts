/**
 * OpenCode 1.17.11 validates user message IDs with `z.string().startsWith('msg')`.
 * Prefix legacy lifecycle IDs at their delivery boundary so queued commands
 * persisted before the schema change remain deliverable after deployment.
 */
export function normalizeOpenCodeMessageId(messageId: string): string {
  return messageId.startsWith('msg') ? messageId : `msg_${messageId}`;
}

export function openCodePromptPayload(text: string, messageId?: string | null): {
  messageID?: string;
  parts: Array<{ type: 'text'; text: string }>;
} {
  return {
    ...(messageId ? { messageID: normalizeOpenCodeMessageId(messageId) } : {}),
    parts: [{ type: 'text', text }],
  };
}
