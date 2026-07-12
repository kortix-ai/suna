// Thin re-export — the project apps/deployments client now lives in the SDK
// (packages/sdk/src/platform/projects-client/apps.ts). Kept here under the
// original names so existing consumers don't need to change their import
// paths.

export {
  listProjectApps,
  createProjectApp,
  updateProjectApp,
  deleteProjectApp,
  deployProjectApp,
  stopProjectApp,
  getProjectAppLogs,
  type AppSourceGit,
  type AppSourceTar,
  type AppSource,
  type AppBuild,
  type DeploymentStatus,
  type ProjectAppDeploymentRow,
  type ProjectApp,
  type ProjectAppParseError,
  type ListProjectAppsResponse,
  type CreateOrUpdateProjectAppInput,
  type DeployProjectAppResponse,
  type StopProjectAppResponse,
  type ProjectAppLogsResponse,
} from '@kortix/sdk/projects-client';
