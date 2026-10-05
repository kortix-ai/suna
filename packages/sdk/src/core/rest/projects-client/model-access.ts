import { backendApi } from "../../http/api-client";
import { unwrap } from "./shared";

/** Project inference restrictions, independent of picker-only visibility preferences. */
export interface ProjectModelAccess {
  disabledProviders: string[];
  disabledModels: string[];
  defaultModel?: string;
  /** False for a native runtime that bypasses the Kortix gateway. */
  enforced?: boolean;
}

export interface ProjectModelAccessChange {
  target: "provider" | "model";
  id: string;
  enabled: boolean;
}

export async function getProjectModelAccess(
  projectId: string,
): Promise<ProjectModelAccess> {
  return unwrap(
    await backendApi.get<ProjectModelAccess>(
      `/projects/${projectId}/model-access`,
    ),
  );
}

/** Change one target without replacing other provider or model preferences. */
export async function setProjectModelAccess(
  projectId: string,
  change: ProjectModelAccessChange,
): Promise<ProjectModelAccess> {
  return unwrap(
    await backendApi.put<ProjectModelAccess>(
      `/projects/${projectId}/model-access`,
      change,
    ),
  );
}
