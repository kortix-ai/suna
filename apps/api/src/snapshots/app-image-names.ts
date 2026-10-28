// Provider image names for App deployments. The deployment worker builds
// them and App/deployment delete and the reclaim sweep (apps/images.ts)
// remove them — all must use these functions, or a rename strands images
// nothing can find.

/** `kortix-app-<deploymentId-no-dashes>` — one per App deployment build. */
export const APP_DEPLOYMENT_PREFIX = 'kortix-app-';

/** The provider image one App deployment build mints. */
export function appDeploymentSnapshotName(deploymentId: string): string {
  return `${APP_DEPLOYMENT_PREFIX}${deploymentId.replaceAll('-', '')}`;
}

/**
 * The inverse of `appDeploymentSnapshotName`: the deployment id an App image
 * belongs to, or null when the name is not exactly that shape. The reclaim
 * sweep keys every delete on this id, so a near-miss name is never touched.
 */
export function deploymentIdFromAppSnapshotName(name: string): string | null {
  const match = /^kortix-app-([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/.exec(name);
  return match ? match.slice(1).join('-') : null;
}

/**
 * `kortix-appimg-<env>-<key>` — one provider image that every App deployment
 * with the same build inputs shares (`apps/images.ts` `appImageName`). This
 * environment tracks each one in `kortix.app_images` and deletes it once no
 * deployment uses it.
 */
export const APP_IMAGE_PREFIX = 'kortix-appimg-';
