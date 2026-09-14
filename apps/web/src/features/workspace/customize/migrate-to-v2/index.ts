export {
  detectManifestVersion,
  useProjectManifestVersion,
  type ManifestVersion,
  type ProjectManifestVersionState,
} from './manifest-version';
export { MigrateToV2Button, MigrateToV2ButtonView } from './migrate-to-v2-button';
export { MIGRATE_TO_V2_PROMPT } from './migration-prompt';
export {
  PROJECT_UPGRADES,
  applicableUpgrades,
  buildOneOffUpgradePrompt,
  type ProjectUpgrade,
  type ProjectUpgradeContext,
} from './upgrade-defs';
export { UpgradesView, UpgradesViewContent } from './upgrade-view';
export { buildMigrateToV2Stash, useMigrateToV2, type MigrateToV2 } from './use-migrate-to-v2';
export { buildUpgradeStash, useRunUpgrade, type RunUpgrade } from './use-run-upgrade';
