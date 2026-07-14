// Barrel for the Kortix platform REST client. Re-exports every name the
// original flat `projects-client.ts` exported, so the public surface is
// byte-identical. The `unwrap` helper in `./shared` stays internal.

export * from './accounts';
export * from './projects';
export * from './github';
export * from './access';
export * from './secrets';
export * from './connectors';
export * from './policies';
export * from './sandbox';
export * from './files';
export * from './git-history';
export * from './change-requests';
export * from './sessions';
export * from './triggers';
export * from './session-sandbox';
export * from './model-defaults';
export * from './agent-scope';
export * from './agent-config';
export * from './composer-capabilities';
export * from './billing';
export * from './channels';
export * from './gateway';
export * from './transcription';
export * from './review';
export * from './sandbox-shares';
export * from './public-session-shares';
export * from './tokens';
export * from './audit';
export * from './setup-links';
export * from './marketplace-catalog';
export * from './templates';

// Cross-cutting types that originally lived in this module. Re-exported
// explicitly (not the internal `unwrap` helper) to keep the surface identical.
export type {
  AccountRole,
  ProjectRole,
  ConnectorSharing,
  ProjectGitConnection,
  ProjectFileEntry,
} from './shared';
