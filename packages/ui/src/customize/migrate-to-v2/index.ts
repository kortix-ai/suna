export {
  detectManifestVersion,
  manifestFilename,
  manifestNeedsUpgrade,
  useProjectManifestVersion,
  type ManifestVersion,
  type ProjectManifestVersionState,
} from '../../internal/lib/manifest-version';
export { MIGRATE_TO_V3_PROMPT } from './migration-prompt';
export {
  PROJECT_UPGRADES,
  applicableUpgrades,
  buildOneOffUpgradePrompt,
  type ProjectUpgrade,
  type ProjectUpgradeContext,
} from './upgrade-defs';
export { UpgradesView, UpgradesViewContent } from './upgrade-view';
export { useRunUpgrade, type RunUpgrade } from './use-run-upgrade';
