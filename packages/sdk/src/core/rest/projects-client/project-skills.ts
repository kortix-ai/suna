import { backendApi } from '../../http/api-client';
import type { ChangeRequest } from './change-requests';
import { unwrap } from './shared';

export interface ProjectSkillImportFile {
  path: string;
  size: number;
}

export interface ImportedProjectSkill {
  slug: string;
  name: string;
  description: string;
  files: ProjectSkillImportFile[];
}

export interface ImportProjectSkillInput {
  fileName: string;
  dataBase64: string;
}

export interface ProjectSkillImportResult {
  skills: ImportedProjectSkill[];
  paths: string[];
  branch: string;
  target: {
    type: 'project_repo';
    repo_url: string;
    repo_name: string | null;
    managed: boolean;
    base_branch: string;
    branch: string;
    path_prefix: '.kortix/opencode/skills';
  };
  commit_sha: string;
  change_request: ChangeRequest;
}

export async function importProjectSkill(projectId: string, input: ImportProjectSkillInput) {
  return unwrap(
    await backendApi.post<ProjectSkillImportResult>(`/projects/${projectId}/skills/import`, input),
  );
}
