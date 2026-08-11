export { MIGRATE_TO_V2_PROMPT } from './migration-prompt';
export {
  detectManifestVersion,
  useWorkspaceManifestVersion,
  type ManifestVersion,
  type WorkspaceManifestVersionState,
} from './manifest-version';
export { useMigrateToV2, buildMigrateToV2Stash, type MigrateToV2 } from './use-migrate-to-v2';
export { useRunUpgrade, buildUpgradeStash, type RunUpgrade } from './use-run-upgrade';
export {
  WORKSPACE_UPGRADES,
  applicableUpgrades,
  buildOneOffUpgradePrompt,
  type WorkspaceUpgrade,
  type WorkspaceUpgradeContext,
} from './upgrade-defs';
export { MigrateToV2Button, MigrateToV2ButtonView } from './migrate-to-v2-button';
export { UpgradesView, UpgradesViewContent } from './upgrade-view';
