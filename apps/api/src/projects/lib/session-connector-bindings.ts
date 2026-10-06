/**
 * Session connector bindings — the historical import path.
 *
 * The implementation lives in four concern modules beside this file; this
 * path re-exports their public surface so every existing importer resolves
 * unchanged. Dead exports were dropped from the surface (they moved to the
 * concern modules as module-private or cross-sibling symbols instead).
 */

// Canonicalization lives in shared/ so pure IAM code can use it without
// inheriting this module's database dependency. Re-exported so existing
// importers are unaffected.
export { canonicalConnectorAlias, publicConnectorAlias } from '../../shared/connector-alias';

export { type ValidatedSessionConnectorBinding, mayUseLegacyDefaultConnection } from './connector-binding-shared';
export {
  loadEmailInstallConnectionId,
  ensureEmailSessionBinding,
  parseSessionConnectorBindings,
  validateSessionConnectorBindings,
  sessionConnectorBindingsRequirePrivateVisibility,
  sessionHasPersonalConnectorBinding,
} from './connector-binding-validate';
export {
  invalidateSessionConnectorLookup,
  resolveSessionConnectorConnectionOutcome,
  resolveSessionConnectorConnection,
} from './connector-binding-resolve';
export {
  listEntitledConnectorConnections,
  listEntitledConnectorConnectionsBatch,
  selectEntitledConnectorConnection,
  resolveProjectDefaultConnectorConnection,
} from './connector-binding-entitlement';
export { resolveEffectiveSessionConnectorBindings, connectorBindingPayloadConflicts } from './connector-binding-effective';
