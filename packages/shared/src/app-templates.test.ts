import { expect, test } from 'bun:test';
import { APP_TEMPLATES } from './app-templates';

const convex = APP_TEMPLATES.convex!;

test('convex: the dashboard is a Dockerfile App in apps/<name>/dashboard, a tab of its backend, signed in by <NAME>_ADMIN_KEY', () => {
  const blocks = convex.blocks('crm-data');
  expect(Object.keys(blocks)).toEqual(['crm-data', 'crm-data-dashboard']);
  expect(blocks['crm-data']!.display).toEqual({ preview: 'none' });
  expect(blocks['crm-data-dashboard']).toMatchObject({
    path: 'apps/crm-data/dashboard',
    type: 'dockerfile',
    command: ['node', '/kortix/start.js'],
    display: { parent: 'crm-data' },
    uses: ['crm-data'],
    http_service: { internal_port: 6791, access: 'admins' },
    secrets: { NEXT_PUBLIC_ADMIN_KEY: 'CRM_DATA_ADMIN_KEY' },
  });
  // No script or shell plumbing in kortix.yaml: it lives in the App's files.
  expect(JSON.stringify(blocks['crm-data-dashboard'])).not.toContain('require(');
  const files = convex.files!('crm-data');
  expect(Object.keys(files)).toEqual(['apps/crm-data/dashboard/Dockerfile', 'apps/crm-data/dashboard/start.js']);
  expect(files['apps/crm-data/dashboard/Dockerfile']).toContain('ENV BACKEND=crm-data');
  expect(files['apps/crm-data/dashboard/Dockerfile']).toMatch(/^FROM ghcr\.io\/convex\/convex-dashboard@sha256:[0-9a-f]{64}$/m);
  expect(convex.secrets!('crm-data')).toEqual([{ name: 'CRM_DATA_ADMIN_KEY', app: 'crm-data', command: ['sh', '-c', 'cd /convex && ./generate_admin_key.sh'] }]);
});

test('convex start.js: starts the dashboard on 6792, answers the embed handshake on /, escapes its values, passes other paths through', () => {
  const start = convex.files!('crm-data')['apps/crm-data/dashboard/start.js']!;
  let handler: ((req: unknown, res: unknown) => void) | undefined;
  let listened: number | undefined;
  const spawned: Array<{ args: string[]; options: { cwd: string; env: Record<string, string> } }> = [];
  const proxied: string[] = [];
  const modules: Record<string, unknown> = {
    child_process: { spawn: (_bin: string, args: string[], options: { cwd: string; env: Record<string, string> }) => { spawned.push({ args, options }); return { on: () => {} }; } },
    http: {
      createServer: (h: typeof handler) => ({ listen: (port: number) => { handler = h; listened = port; } }),
      request: (options: { path: string }) => { proxied.push(options.path); return { on: () => {} }; },
    },
  };
  const env = { KORTIX_APP_URL: 'https://dash.example.test', BACKEND: 'crm-data', NEXT_PUBLIC_ADMIN_KEY: 'key</script><b>' };
  new Function('require', 'process', start)((name: string) => modules[name], { env, exit: () => {} });

  expect(listened).toBe(6791);
  expect(spawned[0]!.args).toEqual(['server.js']);
  expect(spawned[0]!.options.cwd).toBe('/app/dashboard-self-hosted');
  expect(spawned[0]!.options.env).toMatchObject({ PORT: '6792', NEXT_PUBLIC_DEPLOYMENT_URL: 'https://dash.example.test/_kortix/apps/crm-data' });

  let body = '';
  handler!({ method: 'GET', url: '/' }, { writeHead: () => {}, end: (text: string) => { body = text; } });
  expect(body).toContain('<iframe src="/?embedded=1">');
  expect(body).toContain('"deploymentUrl":"https://dash.example.test/_kortix/apps/crm-data"');
  expect(body).not.toContain('</script><b>');
  handler!({ method: 'GET', url: '/?embedded=1', pipe: () => {} }, {});
  expect(proxied).toEqual(['/?embedded=1']);
});
