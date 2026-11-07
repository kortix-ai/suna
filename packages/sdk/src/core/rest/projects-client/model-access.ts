import { backendApi } from "../../http/api-client";
import { unwrap } from "./shared";

/**
 * Project inference restrictions, independent of picker-only visibility preferences.
 *
 * @deprecated Use `WorkspaceModelAccess`. Kept permanently.
 */
export interface ProjectModelAccess {
  disabledProviders: string[];
  disabledModels: string[];
  defaultModel?: string;
  /** @deprecated Always true: the LLM gateway enforces access for every project. Removed in the next major. */
  enforced?: boolean;
}

/** The workspace name of {@link ProjectModelAccess}: the same type. */
export type WorkspaceModelAccess = ProjectModelAccess;

/** @deprecated Use `WorkspaceModelAccessChange`. Kept permanently. */
export interface ProjectModelAccessChange {
  target: "provider" | "model";
  id: string;
  enabled: boolean;
}

/** The workspace name of {@link ProjectModelAccessChange}: the same type. */
export type WorkspaceModelAccessChange = ProjectModelAccessChange;

export async function getWorkspaceModelAccess(
  projectId: string,
): Promise<ProjectModelAccess> {
  return unwrap(
    await backendApi.get<ProjectModelAccess>(
      `/workspaces/${projectId}/model-access`,
    ),
  );
}

/** @deprecated Use `getWorkspaceModelAccess`. Kept permanently. */
export const getProjectModelAccess = getWorkspaceModelAccess;

/** Change one target without replacing other provider or model preferences. */
export async function setWorkspaceModelAccess(
  projectId: string,
  change: ProjectModelAccessChange,
): Promise<ProjectModelAccess> {
  return unwrap(
    await backendApi.put<ProjectModelAccess>(
      `/workspaces/${projectId}/model-access`,
      change,
    ),
  );
}

/** @deprecated Use `setWorkspaceModelAccess`. Kept permanently. */
export const setProjectModelAccess = setWorkspaceModelAccess;
