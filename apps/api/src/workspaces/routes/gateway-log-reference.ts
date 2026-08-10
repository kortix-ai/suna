export type GatewayLogReferenceKind = 'both' | 'request' | 'invalid';

const UUID_V4_REFERENCE_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Gateway log ids and current request ids are both UUIDs. A UUID reference must
 * therefore match either column. Prefixed legacy request ids match request_id.
 */
export function classifyGatewayLogReference(reference: string): GatewayLogReferenceKind {
  if (UUID_V4_REFERENCE_REGEX.test(reference)) return 'both';
  if (reference.startsWith('req_')) return 'request';
  return 'invalid';
}
