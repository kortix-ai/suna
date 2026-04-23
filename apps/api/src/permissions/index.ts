export {
  SCOPE_CATALOG,
  ALL_SCOPES,
  isScope,
  scopesByGroup,
  type Scope,
  type ScopeGroup,
  type ScopeMeta,
} from './catalog';

export {
  ROLE_SCOPES,
  scopesForRole,
  type SandboxRole,
} from './roles';

export {
  resolveRole,
  resolveRoleSync,
  applyOverridesToRole,
  effectiveScopes,
  scopesForEffectiveRole,
  type EffectiveRole,
} from './resolver';

export {
  can,
  canSync,
  hasAnyScope,
  hasAllScopes,
} from './can';

export {
  assertScope,
  requireScope,
  type RequireScopeDeps,
} from './middleware';

export {
  listOverrides,
  setOverride,
  type MemberScopeOverrides,
} from './overrides';

export {
  getOverridesCached,
  invalidateOverrides,
  invalidateSandboxOverrides,
  invalidateUserOverrides,
} from './cache';
