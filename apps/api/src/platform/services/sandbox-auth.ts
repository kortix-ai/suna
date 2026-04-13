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

export function buildCanonicalSandboxAuthCommand(token: string, apiUrl: string): string {
  return `python3 - <<PY
from pathlib import Path
import json

token = ${JSON.stringify(token)}
api_url = ${JSON.stringify(apiUrl)}

s6_dir = Path("/run/s6/container_environment")
s6_dir_parent = s6_dir.parent
if s6_dir_parent.exists() and not s6_dir_parent.is_dir():
    s6_dir_parent.unlink()
s6_dir.mkdir(parents=True, exist_ok=True)
for key, value in {
    "KORTIX_TOKEN": token,
    "INTERNAL_SERVICE_KEY": token,
    "TUNNEL_TOKEN": token,
    "KORTIX_API_URL": api_url,
    "TUNNEL_API_URL": api_url,
}.items():
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
bootstrap.write_text(json.dumps(data))
PY`
}
