// The access layer's public surface. The implementation lives in focused
// sibling modules — every current import of `./access` keeps resolving:
//
//   project-quota.ts      per-account project-quota enforcement
//   session-visibility.ts `loadVisibleSession` / `loadSessionForSharing` and
//                         the session-row loaders behind them
//   user-identity.ts      the user-identity cache and account membership
//                         (`getAccountMembership` moved here from ./git, so
//                         the authorization path no longer imports the Git
//                         module)
//   project-access.ts     capability/action mapping, role grants and
//                         `loadProjectForUser`
export { agentSessionStanding } from './agent-session-standing';
export * from './project-quota';
export * from './session-visibility';
export * from './user-identity';
export * from './project-access';
