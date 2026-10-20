export {
  detectManifestVersion,
  manifestFilename,
  manifestNeedsUpgrade,
  useProjectManifestVersion,
  type ManifestVersion,
  type ProjectManifestVersionState,
} from '../../internal/lib/manifest-version';
export { MIGRATE_TO_V2_PROMPT } from './migration-prompt';
export {
  PROJECT_UPGRADES,
  applicableUpgrades,
  buildOneOffUpgradePrompt,
  type ProjectUpgrade,
  type ProjectUpgradeContext,
} from './upgrade-defs';
export { UpgradesView, UpgradesViewContent } from './upgrade-view';
export { useMigrateToV2, type MigrateToV2 } from './use-migrate-to-v2';
export { useRunUpgrade, type RunUpgrade } from './use-run-upgrade';
