/**
 * Project templates. The API never mounted `/v1/templates`; these exports
 * remain for import compatibility until the next major.
 */
import { retiredEndpointError } from '../../http/api/errors';

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

/** @deprecated The API does not serve templates. Always rejects with `ENDPOINT_RETIRED`. */
export async function getTemplate(_id: string): Promise<TemplateDetail> {
  throw retiredEndpointError('getTemplate');
}

/** @deprecated The API does not serve templates. Always rejects with `ENDPOINT_RETIRED`. */
export async function installTemplate(
  _id: string,
  _body: { project_id: string; inputs: Record<string, string> },
): Promise<TemplateInstallResult> {
  throw retiredEndpointError('installTemplate');
}
