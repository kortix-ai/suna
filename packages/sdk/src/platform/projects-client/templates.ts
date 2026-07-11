import { backendApi } from '../api-client';
import { unwrap } from './shared';

export interface TemplateInput {
  key: string;
  label: string;
  type: 'text' | 'select' | 'cron' | 'channel';
  default?: string;
  help?: string;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
}

export interface TemplateRequirement {
  kind: 'connector' | 'secret' | 'input' | 'channel';
  key: string;
  label: string;
  status: 'new' | 'reused' | 'pending' | 'resolved';
  required: boolean;
  provider?: string;
  input?: TemplateInput;
}

export interface TemplateDetail {
  id: string;
  title: string;
  description: string | null;
  inputs: TemplateInput[];
  requirements: TemplateRequirement[];
  installs: Array<{ name: string; type: string }>;
  connectors: string[];
  secrets: string[];
}

export interface TemplateInstallResult {
  ok: boolean;
  project_id: string;
  commit_sha: string;
  branch: string;
  requirements: TemplateRequirement[];
  trigger_slugs: string[];
}

/** Public — template detail + a requirement preview (built against an empty project). */
export async function getTemplate(id: string): Promise<TemplateDetail> {
  return unwrap(await backendApi.get<TemplateDetail>(`/templates/${encodeURIComponent(id)}`));
}

/** Apply a template into a project: renders inputs, merges the manifest, commits. */
export async function installTemplate(
  id: string,
  body: { project_id: string; inputs: Record<string, string> },
): Promise<TemplateInstallResult> {
  return unwrap(
    await backendApi.post<TemplateInstallResult>(`/templates/${encodeURIComponent(id)}/install`, body),
  );
}
