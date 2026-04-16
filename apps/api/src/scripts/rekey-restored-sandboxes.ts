import { and, eq } from 'drizzle-orm';
import { kortixApiKeys, sandboxes } from '@kortix/db';
import { db } from '../shared/db';
import { createApiKey } from '../repositories/api-keys';
import { config, SANDBOX_VERSION } from '../config';
import { buildJustAVPSHostRecoveryCommand, isProxyTokenStale, refreshSandboxProxyToken } from '../platform/providers/justavps';

function getArg(flag: string): string | null {
  const exact = Bun.argv.find((arg) => arg === flag);
  if (exact) {
    return Bun.argv[Bun.argv.indexOf(exact) + 1] ?? null;
  }

  const prefixed = Bun.argv.find((arg) => arg.startsWith(`${flag}=`));
  return prefixed ? prefixed.slice(flag.length + 1) : null;
}

function buildEnvPayload(serviceKey: string, metadata: Record<string, unknown>): Record<string, string> {
  const sandboxApiBase = config.KORTIX_URL.replace(/\/v1\/router\/?$/, '');
  const routerBase = `${sandboxApiBase}/v1/router`;
  const payload: Record<string, string> = {
    KORTIX_API_URL: sandboxApiBase,
    ENV_MODE: 'cloud',
    INTERNAL_SERVICE_KEY: serviceKey,
    KORTIX_TOKEN: serviceKey,
    KORTIX_SANDBOX_VERSION: SANDBOX_VERSION,
    SANDBOX_VERSION,
    KORTIX_YOLO_API_KEY: serviceKey,
    KORTIX_YOLO_URL: config.KORTIX_YOLO_URL,
    TAVILY_API_URL: `${routerBase}/tavily`,
    REPLICATE_API_URL: `${routerBase}/replicate`,
    SERPER_API_URL: `${routerBase}/serper`,
    FIRECRAWL_API_URL: `${routerBase}/firecrawl`,
    TUNNEL_API_URL: sandboxApiBase,
    TUNNEL_TOKEN: serviceKey,
  };

  const slug = metadata.justavpsSlug as string | undefined;
  const proxyToken = metadata.justavpsProxyToken as string | undefined;
  if (slug && proxyToken) {
    payload.PUBLIC_BASE_URL = `https://8000--${slug}.${config.JUSTAVPS_PROXY_DOMAIN}?__proxy_token=${proxyToken}`;
  }

  return payload;
}

function buildHostEnvCommand(keys: Record<string, string>): string {
  const envLines = Object.entries(keys)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const removeKeys = Object.keys(keys)
    .map((key) => `grep -v "^${key}=" "$ENV_FILE" > "$TEMP_FILE" 2>/dev/null || true; mv "$TEMP_FILE" "$ENV_FILE"`)
    .join('\n');

  return [
    'set -euo pipefail',
    'ENV_FILE="/etc/justavps/env"',
    'touch "$ENV_FILE"',
    'TEMP_FILE="$(mktemp)"',
    removeKeys,
    `cat >> "$ENV_FILE" <<'ENVEOF'\n${envLines}\nENVEOF`,
    buildJustAVPSHostRecoveryCommand(),
  ].join('\n');
}

const accountId = getArg('--account-id');
const limit = Number(getArg('--limit') ?? '0');

let query = db.select().from(sandboxes).where(eq(sandboxes.provider, 'justavps'));
const rows = await query;
const filtered = rows
  .filter((row) => !accountId || row.accountId === accountId)
  .slice(0, limit > 0 ? limit : rows.length);

console.log(JSON.stringify({ phase: 'plan', total: filtered.length, accountId: accountId ?? null }, null, 2));

let success = 0;
let failed = 0;

for (const row of filtered) {
  const metadata = ((row.metadata as Record<string, unknown> | null) ?? {});
  try {
    const proxy = isProxyTokenStale(metadata)
      ? await refreshSandboxProxyToken(row.externalId!, metadata)
      : {
          token: metadata.justavpsProxyToken as string,
          id: metadata.justavpsProxyTokenId as string,
          expiresAt: metadata.justavpsProxyTokenExpiresAt as number,
        };

    const freshMetadata = proxy
      ? {
          ...metadata,
          justavpsProxyToken: proxy.token,
          justavpsProxyTokenId: proxy.id,
          justavpsProxyTokenExpiresAt: proxy.expiresAt,
        }
      : metadata;

    if (!freshMetadata.justavpsProxyToken) {
      throw new Error('Missing JustAVPS proxy token');
    }

    const existingKeys = await db
      .select({ keyId: kortixApiKeys.keyId })
      .from(kortixApiKeys)
      .where(and(eq(kortixApiKeys.sandboxId, row.sandboxId), eq(kortixApiKeys.type, 'sandbox')));

    for (const existing of existingKeys) {
      await db.delete(kortixApiKeys).where(eq(kortixApiKeys.keyId, existing.keyId));
    }

    const created = await createApiKey({
      sandboxId: row.sandboxId,
      accountId: row.accountId,
      title: 'Sandbox Token',
      type: 'sandbox',
    });

    await db.update(sandboxes)
      .set({
        config: { serviceKey: created.secretKey },
        metadata: freshMetadata,
        updatedAt: new Date(),
      })
      .where(eq(sandboxes.sandboxId, row.sandboxId));

    const slug = freshMetadata.justavpsSlug as string | undefined;
    const toolboxUrl = `https://${slug}.${config.JUSTAVPS_PROXY_DOMAIN}/toolbox/process/execute`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Proxy-Token': freshMetadata.justavpsProxyToken as string,
    };
    const command = buildHostEnvCommand(buildEnvPayload(created.secretKey, freshMetadata));
    const response = await fetch(toolboxUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command, timeout: 180 }),
      signal: AbortSignal.timeout(210_000),
    });

    if (!response.ok) {
      throw new Error(`Toolbox returned ${response.status}: ${await response.text()}`);
    }

    const verify = await fetch(`https://8000--${slug}.${config.JUSTAVPS_PROXY_DOMAIN}/kortix/health`, {
      headers: {
        'X-Proxy-Token': freshMetadata.justavpsProxyToken as string,
        Authorization: `Bearer ${created.secretKey}`,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!verify.ok) {
      throw new Error(`Health verify failed with ${verify.status}`);
    }

    success += 1;
    console.log(JSON.stringify({ sandboxId: row.sandboxId, externalId: row.externalId, status: 'ok' }));
  } catch (error) {
    failed += 1;
    console.log(JSON.stringify({
      sandboxId: row.sandboxId,
      externalId: row.externalId,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

console.log(JSON.stringify({ phase: 'done', success, failed }, null, 2));
