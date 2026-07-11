import { getEnv } from '@/lib/env-config';

export { installTemplate } from '@kortix/sdk/projects-client';
export type {
  TemplateDetail,
  TemplateInput,
  TemplateRequirement,
  TemplateInstallResult,
} from '@kortix/sdk/projects-client';

import type { TemplateDetail } from '@kortix/sdk/projects-client';

function apiBase(): string {
  return getEnv().BACKEND_URL || '/v1';
}

/** Public preview — no auth, so the wizard's Review/Configure work signed-out. */
export async function getTemplate(id: string): Promise<TemplateDetail> {
  const res = await fetch(`${apiBase()}/templates/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Template "${id}" not found`);
  return (await res.json()) as TemplateDetail;
}
