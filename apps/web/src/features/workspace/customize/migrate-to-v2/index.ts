export { MIGRATE_TO_V2_PROMPT } from './migration-prompt';
export {
  detectManifestVersion,
  useProjectManifestVersion,
  type ManifestVersion,
  type ProjectManifestVersionState,
} from './manifest-version';
export { useMigrateToV2, buildMigrateToV2Stash, type MigrateToV2 } from './use-migrate-to-v2';
export { useRunUpgrade, buildUpgradeStash, type RunUpgrade } from './use-run-upgrade';
export {
  PROJECT_UPGRADES,
  applicableUpgrades,
  buildOneOffUpgradePrompt,
  type ProjectUpgrade,
  type ProjectUpgradeContext,
} from './upgrade-defs';
export { MigrateToV2Button, MigrateToV2ButtonView } from './migrate-to-v2-button';
export { UpgradesView, UpgradesViewContent } from './upgrade-view';
