import { pathToFileURL } from 'node:url';

export function vercelWebDomain(environment) {
  if (environment !== 'dev') throw new Error('only the Dev Vercel detachment is enabled');
  return 'dev.kortix.com';
}

async function vercel(path, options = {}) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error('VERCEL_TOKEN is required');

  const teamId = process.env.VERCEL_TEAM_ID;
  if (!teamId) throw new Error('VERCEL_TEAM_ID is required');

  const url = new URL(`https://api.vercel.com${path}`);
  url.searchParams.set('teamId', teamId);
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const body = await response.text();
  const payload = body ? JSON.parse(body) : {};
  if (!response.ok) {
    throw new Error(`Vercel ${options.method || 'GET'} ${url.pathname} failed`);
  }
  return payload;
}

export async function detachVercelWebDomain(environment) {
  const domain = vercelWebDomain(environment);
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!projectId) throw new Error('VERCEL_PROJECT_ID is required');

  const path = `/v9/projects/${encodeURIComponent(projectId)}/domains`;
  const before = await vercel(path);
  const binding = before.domains?.find((candidate) => candidate.name === domain);
  if (!binding) return { action: 'already-detached', domain };

  await vercel(`${path}/${encodeURIComponent(domain)}`, { method: 'DELETE' });
  const after = await vercel(path);
  if (after.domains?.some((candidate) => candidate.name === domain)) {
    throw new Error(`Vercel still binds ${domain} after deletion`);
  }
  return { action: 'detached', domain };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await detachVercelWebDomain(process.argv[2]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
