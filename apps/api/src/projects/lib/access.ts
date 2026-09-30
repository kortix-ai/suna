// The access layer's public surface. Implementation lives in the sibling
// modules below; every current import of `./access` keeps resolving.
// `getAccountMembership` moved here from ./git (user-identity.ts).
export { agentSessionStanding } from './agent-session-standing';
export * from './project-quota';
export * from './session-visibility';
export * from './user-identity';
export * from './project-access';
