import { pathToFileURL } from 'node:url';

const ZONE_ID = process.env.CLOUDFLARE_ZONE_ID || 'af378d3df4e4dd5052a1fcbf263b685d';

export function webDnsRecord(environment, mode, target) {
  if (environment !== 'dev') throw new Error('only the Dev DNS cutover is enabled');
  if (!['origin', 'canonical'].includes(mode)) {
    throw new Error('mode must be origin or canonical');
  }
  if (!/^[a-z0-9.-]+\.elb\.amazonaws\.com$/.test(target)) {
    throw new Error('target must be an AWS ELB hostname');
  }
  return {
    type: 'CNAME',
    name: mode === 'origin' ? 'dev-web-ecs-fargate.kortix.com' : 'dev.kortix.com',
    content: target,
    proxied: true,
    ttl: 1,
    comment: 'Kortix Dev web ECS Fargate origin',
  };
}

async function cloudflare(path, options = {}) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required');
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    throw new Error(`Cloudflare ${options.method || 'GET'} ${path.split('?')[0]} failed`);
  }
  return payload.result;
}

export async function syncWebDns(environment, mode, target) {
  const record = webDnsRecord(environment, mode, target);
  const query = new URLSearchParams({ type: record.type, name: record.name });
  const existing = await cloudflare(`/zones/${ZONE_ID}/dns_records?${query}`);
  if (existing.length > 1) throw new Error(`multiple DNS records exist for ${record.name}`);
  const current = existing[0];
  const method = current ? 'PUT' : 'POST';
  const path = current
    ? `/zones/${ZONE_ID}/dns_records/${current.id}`
    : `/zones/${ZONE_ID}/dns_records`;
  const result = await cloudflare(path, { method, body: JSON.stringify(record) });
  if (result.name !== record.name || result.content !== target || result.proxied !== true) {
    throw new Error(`Cloudflare did not persist the expected record for ${record.name}`);
  }
  return { action: current ? 'updated' : 'created', id: result.id, ...record };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await syncWebDns(process.argv[2], process.argv[3], process.argv[4]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
