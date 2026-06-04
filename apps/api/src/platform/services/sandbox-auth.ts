import { and, eq, ne } from 'drizzle-orm';
import { sandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { config } from '../../config';

export function getAuthCandidates(primary?: string): string[] {
  return Array.from(new Set([
    primary,
    config.INTERNAL_SERVICE_KEY,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)));
}

export async function getSandboxServiceKeyByExternalId(externalId: string): Promise<string> {
  const [row] = await db
    .select({ config: sandboxes.config })
    .from(sandboxes)
    .where(and(eq(sandboxes.externalId, externalId), ne(sandboxes.status, 'pooled')))
    .limit(1);

  const configJson = (row?.config || {}) as Record<string, unknown>;
  return typeof configJson.serviceKey === 'string' ? configJson.serviceKey : '';
}

export async function getLocalSandboxServiceKey(): Promise<string> {
  return getSandboxServiceKeyByExternalId(config.SANDBOX_CONTAINER_NAME);
}

/**
 * Generate the s6/bootstrap auth script that runs inside a sandbox at boot.
 *
 * Billing v2 — `yoloApiKey` is the per-member YOLO token resolved by
 * services/yolo-tokens.ts at provision time. When provided, it's used as
 * KORTIX_YOLO_API_KEY so the kortix-agent-sandbox-server / opencode demon
 * authenticates against api-yolo.kortix.com as that specific member. When
 * absent (legacy accounts, non-cloud env, or token resolution failure), we
 * fall back to the legacy behaviour: cloud sandboxes get the account-wide
 * service key as their YOLO key.
 */
export function buildCanonicalSandboxAuthCommand(
  token: string,
  apiUrl: string,
  llmApiKey?: string | null,
): string {
  const effectiveLlmKey = llmApiKey ?? token;
  const llmBaseUrl = `${apiUrl.replace(/\/+$/, '')}/llm`;
  return `python3 - <<PY
from pathlib import Path
import json

token = ${JSON.stringify(token)}
llm_key = ${JSON.stringify(effectiveLlmKey)}
api_url = ${JSON.stringify(apiUrl)}
llm_base_url = ${JSON.stringify(llmBaseUrl)}
billing_enabled = ${config.KORTIX_BILLING_INTERNAL_ENABLED ? 'True' : 'False'}

s6_dir = Path("/run/s6/container_environment")
s6_dir_parent = s6_dir.parent
if s6_dir_parent.exists() and not s6_dir_parent.is_dir():
    s6_dir_parent.unlink()
s6_dir.mkdir(parents=True, exist_ok=True)
values = {
    "KORTIX_TOKEN": token,
    "INTERNAL_SERVICE_KEY": token,
    "TUNNEL_TOKEN": token,
    "KORTIX_API_URL": api_url,
    "TUNNEL_API_URL": api_url,
}
if billing_enabled:
    values["KORTIX_LLM_API_KEY"] = llm_key
    values["KORTIX_LLM_BASE_URL"] = llm_base_url
    values["KORTIX_YOLO_API_KEY"] = llm_key
    values["KORTIX_YOLO_URL"] = llm_base_url
for key, value in values.items():
    (s6_dir / key).write_text(value)

bootstrap = Path("/workspace/.secrets/.bootstrap-env.json")
secrets_dir = bootstrap.parent
if secrets_dir.exists() and not secrets_dir.is_dir():
    secrets_dir.unlink()
secrets_dir.mkdir(parents=True, exist_ok=True)
try:
    data = json.loads(bootstrap.read_text())
except Exception:
    data = {}
data.update({
    "KORTIX_TOKEN": token,
    "INTERNAL_SERVICE_KEY": token,
    "TUNNEL_TOKEN": token,
    "KORTIX_API_URL": api_url,
})
if billing_enabled:
    data["KORTIX_LLM_API_KEY"] = llm_key
    data["KORTIX_LLM_BASE_URL"] = llm_base_url
    data["KORTIX_YOLO_API_KEY"] = llm_key
    data["KORTIX_YOLO_URL"] = llm_base_url
bootstrap.write_text(json.dumps(data))
PY`
}
