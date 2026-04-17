import { afterEach, describe, expect, mock, test } from 'bun:test';
import { config } from '../config';
import {
  buildCustomerCloudInitScript,
  buildJustAVPSHostRecoveryCommand,
  JustAVPSProvider,
} from '../platform/providers/justavps';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('JustAVPS provider bootstrap script resolution', () => {
  test('buildCustomerCloudInitScript embeds sandbox bootstrap', () => {
    const script = buildCustomerCloudInitScript('kortix/computer:0.8.20');
    expect(script).toContain('/usr/local/bin/kortix-start-sandbox.sh');
    expect(script).toContain('kortix/computer:0.8.20');
    expect(script).toContain('raw.githubusercontent.com/kortix-ai/suna/main/scripts/start-sandbox.sh');
  });

  test('buildJustAVPSHostRecoveryCommand restarts the workload and verifies health', () => {
    const command = buildJustAVPSHostRecoveryCommand();
    expect(command).toContain('systemctl start docker.service');
    expect(command).toContain('systemctl restart justavps-docker');
    expect(command).toContain('docker inspect --format="{{.State.Status}}" justavps-workload');
    expect(command).toContain('curl -fsS http://localhost:8000/kortix/health');
  });

  test('create recovers a machine after provider returns 500 but machine exists', async () => {
    const provider = new JustAVPSProvider();
    let requestedMachineName = 'unknown-machine';
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.endsWith('/webhooks') && method === 'GET') {
        return new Response(JSON.stringify({ webhooks: [{ url: config.JUSTAVPS_WEBHOOK_URL }] }), { status: 200 });
      }

      if (url.endsWith('/images') && method === 'GET') {
        return new Response(JSON.stringify({
          images: [{
            id: 'img-ready',
            name: 'kortix-computer-v9.9.9',
            status: 'ready',
            created_at: new Date().toISOString(),
          }],
        }), { status: 200 });
      }

      if (url.endsWith('/machines') && method === 'POST') {
        requestedMachineName = JSON.parse(String(init?.body || '{}')).name || requestedMachineName;
        return new Response(JSON.stringify({ error: true, message: 'Internal server error', status: 500 }), { status: 500 });
      }

      if (url.endsWith('/machines') && method === 'GET') {
        return new Response(JSON.stringify({
          machines: [{
            id: 'machine-recovered',
            slug: 'recover123',
            name: requestedMachineName,
            status: 'provisioning',
            provisioning_stage: 'server_creating',
            provisioning_stage_updated_at: new Date().toISOString(),
            provider: 'cloud',
            image_id: 'img-ready',
            server_type: 'cpx32',
            region: 'nbg1',
            ip: null,
            price_monthly: null,
            backups_enabled: true,
            source: 'user',
            kortix_sandbox_id: null,
            created_at: new Date().toISOString(),
            ready_at: null,
            urls: null,
            ssh: null,
            ssh_key: null,
            connect: null,
            health: null,
          }],
        }), { status: 200 });
      }

      if (url.endsWith('/proxy-tokens') && method === 'POST') {
        return new Response(JSON.stringify({
          id: 'proxy-1',
          token: 'pt_test',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }), { status: 200 });
      }

      throw new Error(`Unexpected fetch ${method} ${url}`);
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await provider.create({
      accountId: 'acc12345-0000-4000-a000-000000000001',
      userId: 'user-1',
      name: 'Recovered sandbox',
      envVars: { KORTIX_TOKEN: 'kortix_sb_test' },
    } as any);

    expect(result.externalId).toBe('machine-recovered');
    expect(result.baseUrl).toBe(`https://recover123.${config.JUSTAVPS_PROXY_DOMAIN}`);
    expect((result.metadata as Record<string, unknown>).justavpsSlug).toBe('recover123');

    const machinePostCall = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/machines') && (init?.method || 'GET') === 'POST');
    expect(machinePostCall).toBeTruthy();

    const recoveredListCall = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/machines') && (init?.method || 'GET') === 'GET');
    expect(recoveredListCall).toBeTruthy();
  });
});
