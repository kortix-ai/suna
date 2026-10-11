import { expect, test } from 'bun:test';
import { APP_TEMPLATES } from './app-templates';

test('convex: the dashboard sign-in page answers the embed handshake, escapes its values and passes other paths to the dashboard', () => {
  const block = APP_TEMPLATES.convex!.blocks('crm-data')['crm-data-dashboard']!;
  expect(block.display).toEqual({ parent: 'crm-data' });
  expect(block.secrets).toEqual({ NEXT_PUBLIC_ADMIN_KEY: 'CRM_DATA_ADMIN_KEY' });
  let handler: ((req: unknown, res: unknown) => void) | undefined;
  const proxied: string[] = [];
  const http = {
    createServer: (h: typeof handler) => ({ listen: () => { handler = h; } }),
    request: (options: { path: string }) => { proxied.push(options.path); return { on: () => {} }; },
  };
  const env = { NEXT_PUBLIC_ADMIN_KEY: 'key</script><b>', NEXT_PUBLIC_DEPLOYMENT_URL: 'https://db.example.test/_kortix/apps/crm-data', DASHBOARD_NAME: 'crm-data' };
  new Function('require', 'process', (block.env as { SIGNIN_PROXY: string }).SIGNIN_PROXY)(() => http, { env });
  let body = '';
  handler!({ method: 'GET', url: '/' }, { writeHead: () => {}, end: (text: string) => { body = text; } });
  expect(body).toContain('<iframe src="/?embedded=1">');
  expect(body).toContain('"type":"dashboard-credentials"');
  expect(body).not.toContain('</script><b>');
  handler!({ method: 'GET', url: '/?embedded=1', pipe: () => {} }, {});
  expect(proxied).toEqual(['/?embedded=1']);
});
