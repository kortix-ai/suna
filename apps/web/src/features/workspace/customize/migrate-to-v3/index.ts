export {
  detectManifestVersion,
  manifestFilename,
  manifestNeedsUpgrade,
  useProjectManifestVersion,
  type ManifestVersion,
  type ProjectManifestVersionState,
} from './manifest-version';
export { MIGRATE_TO_V3_PROMPT } from './migration-prompt';
export {
  PROJECT_UPGRADES,
  applicableUpgrades,
  buildOneOffUpgradePrompt,
  type ProjectUpgrade,
  type ProjectUpgradeContext,
} from './upgrade-defs';
export { UpgradesView, UpgradesViewContent } from './upgrade-view';
export { buildMigrateToV3Stash, useMigrateToV3, type MigrateToV3 } from './use-migrate-to-v3';
export { buildUpgradeStash, useRunUpgrade, type RunUpgrade } from './use-run-upgrade';
