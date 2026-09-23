/**
 * @deprecated The connector-level authorization strategy is retired. Reachability
 * is a property of the connection row — see `./connection-access`. This module
 * stays as a re-export so nothing outside the connectors area breaks on the move.
 */
export type { ConnectionOwnerType } from './connection-access';
export {
  connectionIsReachable,
  isTrustedManagedChannelAuthorization,
} from './connection-access';

/** @deprecated Kept on the wire and in the manifest parser; nothing reads it. */
export type ConnectorAuthorizationStrategy = 'project' | 'user';
