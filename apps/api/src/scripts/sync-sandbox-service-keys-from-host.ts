import { and, eq } from 'drizzle-orm';
import { kortixApiKeys, sandboxes } from '@kortix/db';
import { db } from '../shared/db';
import { config } from '../config';
import { generateSandboxKeyPair, hashSecretKey, isKortixToken } from '../shared/crypto';
import { isProxyTokenStale, refreshSandboxProxyToken } from '../platform/providers/justavps';

function getArg(flag: string): string | null {
  const exact = Bun.argv.find((arg) => arg === flag);
  if (exact) return Bun.argv[Bun.argv.indexOf(exact) + 1] ?? null;
  const prefixed = Bun.argv.find((arg) => arg.startsWith(`${flag}=`));
  return prefixed ? prefixed.slice(flag.length + 1) : null;
}

const accountIdFilter = getArg('--account-id');
const limit = Number(getArg('--limit') ?? '0');
const concurrency = Math.max(1, Number(getArg('--concurrency') ?? '24'));
const externalIdsFilter = (getArg('--external-ids') ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const allRows = await db.select().from(sandboxes).where(eq(sandboxes.provider, 'justavps'));
const rows = allRows
  .filter((row) => !accountIdFilter || row.accountId === accountIdFilter)
  .filter((row) => externalIdsFilter.length === 0 || externalIdsFilter.includes(row.externalId ?? ''))
  .slice(0, limit > 0 ? limit : allRows.length);

console.log(JSON.stringify({ phase: 'plan', count: rows.length, accountId: accountIdFilter ?? null }, null, 2));

let success = 0;
let failed = 0;
let skipped = 0;

async function verifyWithToken(slug: string, proxyToken: string, token: string): Promise<boolean> {
  try {
    const verify = await fetch(`https://8000--${slug}.${config.JUSTAVPS_PROXY_DOMAIN}/global/health`, {
      headers: {
        'X-Proxy-Token': proxyToken,
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(15_000),
    });
    return verify.ok;
  } catch {
    return false;
  }
}

async function processRow(row: typeof sandboxes.$inferSelect) {
  try {
    const metadata = ((row.metadata as Record<string, unknown> | null) ?? {});
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

    const slug = freshMetadata.justavpsSlug as string | undefined;
    const proxyToken = freshMetadata.justavpsProxyToken as string | undefined;
    if (!slug || !proxyToken) throw new Error('Missing proxy token or slug');

    const currentServiceKey = typeof ((row.config as Record<string, unknown> | null) ?? {}).serviceKey === 'string'
      ? String(((row.config as Record<string, unknown>).serviceKey))
      : '';

    if (currentServiceKey && await verifyWithToken(slug, proxyToken, currentServiceKey)) {
      skipped += 1;
      console.log(JSON.stringify({ sandboxId: row.sandboxId, externalId: row.externalId, status: 'skipped' }));
      return;
    }

    const toolboxUrl = `https://${slug}.${config.JUSTAVPS_PROXY_DOMAIN}/toolbox/process/execute`;
    const tokenRes = await fetch(toolboxUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proxy-Token': proxyToken,
      },
      body: JSON.stringify({
        command: [
          'set -e',
          'TOKEN="$(docker exec justavps-workload sh -lc \"printenv KORTIX_TOKEN\" 2>/dev/null | tr -d \"\\r\" || true)"',
          'if [ -z "$TOKEN" ]; then TOKEN="$(grep -E "^(KORTIX_TOKEN|INTERNAL_SERVICE_KEY)=" /etc/justavps/env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "\\r" || true)"; fi',
          'printf "%s" "$TOKEN"',
        ].join('\n'),
        timeout: 15,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!tokenRes.ok) throw new Error(`Toolbox token read failed (${tokenRes.status})`);
    const tokenBody = await tokenRes.json() as { stdout?: string; stderr?: string; exit_code?: number };
    const token = String(tokenBody.stdout ?? '').trim();
    if (!isKortixToken(token)) throw new Error(`Invalid token from host: ${token.slice(0, 16)}`);

    const tokenHash = hashSecretKey(token);
    const [existingKey] = await db
      .select({ keyId: kortixApiKeys.keyId })
      .from(kortixApiKeys)
      .where(eq(kortixApiKeys.secretKeyHash, tokenHash))
      .limit(1);

    if (existingKey) {
      await db
        .update(kortixApiKeys)
        .set({
          sandboxId: row.sandboxId,
          accountId: row.accountId,
          status: 'active',
        })
        .where(eq(kortixApiKeys.keyId, existingKey.keyId));
    } else {
      const { publicKey } = generateSandboxKeyPair();
      await db.insert(kortixApiKeys).values({
        sandboxId: row.sandboxId,
        accountId: row.accountId,
        publicKey,
        secretKeyHash: tokenHash,
        title: 'Recovered Sandbox Token',
        description: 'Recovered from running sandbox host',
        type: 'sandbox',
        status: 'active',
        expiresAt: null,
      });
    }

    await db
      .update(sandboxes)
      .set({
        config: { serviceKey: token },
        metadata: freshMetadata,
        updatedAt: new Date(),
      })
      .where(eq(sandboxes.sandboxId, row.sandboxId));

    if (!(await verifyWithToken(slug, proxyToken, token))) {
      throw new Error('Verification failed');
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

let index = 0;
async function worker() {
  while (index < rows.length) {
    const current = rows[index];
    index += 1;
    if (!current) return;
    await processRow(current);
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, rows.length || 1) }, () => worker()));

console.log(JSON.stringify({ phase: 'done', success, skipped, failed, concurrency }, null, 2));
