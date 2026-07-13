export function isAcpPromptEnvelope(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  return envelope.jsonrpc === '2.0'
    && Object.prototype.hasOwnProperty.call(envelope, 'id')
    && envelope.method === 'session/prompt';
}
