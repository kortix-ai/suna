import { isUuid } from '../../shared/validate';

export type GatewayLogReferenceKind = 'both' | 'request' | 'invalid';

/**
 * Gateway log ids and current request ids are both UUIDs. A UUID reference must
 * therefore match either column. Prefixed legacy request ids match request_id.
 */
export function classifyGatewayLogReference(reference: string): GatewayLogReferenceKind {
  if (isUuid(reference)) return 'both';
  if (reference.startsWith('req_')) return 'request';
  return 'invalid';
}
