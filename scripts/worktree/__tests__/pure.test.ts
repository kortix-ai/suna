import { describe, expect, test } from 'bun:test';
import {
  BASE,
  DEV_GATEWAY_INTERNAL_TOKEN,
  STRIDE,
  apiLaunchEnv,
  computePorts,
  dbModeOf,
  gatewayLaunchEnv,
  lowestFreeSlot,
  primaryCredsFromStatus,
  rewriteConfigToml,
  sanitizeName,
  SHARED_SUPABASE_PORTS,
  slotCredsFromStatus,
  webLaunchEnv,
  type Ports,
  type Registry,
} from '../lib';

describe('computePorts', () => {
  test('slot 0 is the base block', () => {
    expect(computePorts(0)).toEqual(BASE as unknown as Ports);
  });

  test('each slot offsets every port by slot*STRIDE', () => {
    const p = computePorts(3);
    for (const k of Object.keys(BASE) as (keyof typeof BASE)[]) {
      expect(p[k]).toBe(BASE[k] + 3 * STRIDE);
    }
  });

  test('no two ports ever collide across the first 32 slots', () => {
    const seen = new Map<number, string>();
    for (let slot = 0; slot < 32; slot++) {
      const p = computePorts(slot);
      for (const [name, port] of Object.entries(p)) {
        const prev = seen.get(port);
        expect(prev, `port ${port} reused by slot${slot}/${name} and ${prev}`).toBeUndefined();
        seen.set(port, `slot${slot}/${name}`);
      }
    }
  });
});

describe('sanitizeName', () => {
  test('lowercases, collapses junk to single dashes, trims edges', () => {
    expect(sanitizeName('  My Feature!! ')).toBe('my-feature');
    expect(sanitizeName('Foo__Bar//Baz')).toBe('foo-bar-baz');
    expect(sanitizeName('---x---')).toBe('x');
  });

  test('caps length at 40', () => {
    expect(sanitizeName('a'.repeat(80)).length).toBe(40);
  });

  test('throws on empty/garbage', () => {
    expect(() => sanitizeName('!!!')).toThrow();
    expect(() => sanitizeName('   ')).toThrow();
  });
});

describe('lowestFreeSlot', () => {
  const reg = (slots: number[]): Registry => ({
    version: 1,
    slots: Object.fromEntries(slots.map((s) => [`w${s}`, { slot: s } as Registry['slots'][string]])),
  });

  test('returns 0 for an empty registry', () => {
    expect(lowestFreeSlot(reg([]))).toBe(0);
  });

  test('fills the lowest gap, not the next-highest', () => {
    expect(lowestFreeSlot(reg([0, 1, 3]))).toBe(2);
    expect(lowestFreeSlot(reg([0, 1, 2]))).toBe(3);
  });
});

describe('dbModeOf', () => {
  test('defaults old registry entries to isolated for backward compatibility', () => {
    expect(dbModeOf({})).toBe('isolated');
  });

  test('preserves explicit shared mode for new default worktrees', () => {
    expect(dbModeOf({ dbMode: 'shared' })).toBe('shared');
  });
});

describe('rewriteConfigToml', () => {
  const toml = [
    'project_id = "kortix-local"',
    '[api]',
    'port = 54321',
    '[db]',
    'port = 54322',
    '[studio]',
    'port = 54323',
    'extra = "http://localhost:54321/auth"',
    'site = "http://localhost:3000"',
  ].join('\n');

  test('rewrites project_id + per-section ports + host:port references', () => {
    const ports = computePorts(2);
    const out = rewriteConfigToml(toml, 'kortix-fe', ports);
    expect(out).toContain('project_id = "kortix-fe"');
    expect(out).toContain(`port = ${ports.sbApi}`); // [api]
    expect(out).toContain(`port = ${ports.sbDb}`); // [db]
    expect(out).toContain(`port = ${ports.sbStudio}`); // [studio]
    expect(out).toContain(`http://localhost:${ports.sbApi}/auth`);
    expect(out).toContain(`http://localhost:${ports.web}`);
    expect(out).not.toContain('54321');
    expect(out).not.toContain(':3000');
  });
});

describe('launch envs', () => {
  const ports = computePorts(1);
  const creds = slotCredsFromStatus(ports, {});

  test('api routes sandbox LLM through the local gateway proxy port', () => {
    const env = apiLaunchEnv(ports, creds);
    expect(env.PORT).toBe(String(ports.api));
    expect(env.LLM_GATEWAY_ENABLED).toBe('true');
    expect(env.LLM_GATEWAY_PROXY_PORT).toBe(String(ports.gateway));
    expect(env.GATEWAY_INTERNAL_TOKEN).toBe(DEV_GATEWAY_INTERNAL_TOKEN);
    expect(env.KORTIX_BILLING_INTERNAL_ENABLED).toBe('false');
  });

  test('worktrees do not pin a sandbox provider over dotenv or shell configuration', () => {
    const env = apiLaunchEnv(ports, creds);
    expect(env.ALLOWED_SANDBOX_PROVIDERS).toBeUndefined();
  });

  test('--stripe turns billing on and injects the webhook secret', () => {
    const env = apiLaunchEnv(ports, creds, { stripeWebhookSecret: 'whsec_x' });
    expect(env.KORTIX_BILLING_INTERNAL_ENABLED).toBe('true');
    expect(env.STRIPE_WEBHOOK_SECRET).toBe('whsec_x');
  });

  test('api and gateway share the SAME internal token (mutual auth invariant)', () => {
    const api = apiLaunchEnv(ports, creds);
    const gw = gatewayLaunchEnv(ports);
    expect(gw.GATEWAY_INTERNAL_TOKEN).toBe(api.GATEWAY_INTERNAL_TOKEN);
    expect(gw.PORT).toBe(String(ports.gateway));
    expect(gw.KORTIX_API_URL).toBe(`http://localhost:${ports.api}`);
  });

  test('web proxies to the worktree api, not the shared 8008', () => {
    const env = webLaunchEnv(ports, creds);
    expect(env.WEB_PORT).toBe(String(ports.web));
    expect(env.KORTIX_API_PROXY_TARGET).toBe(`http://localhost:${ports.api}`);
  });

  test('api-generated links target the worktree web port', () => {
    const env = apiLaunchEnv(ports, creds);
    expect(env.FRONTEND_URL).toBe(`http://localhost:${ports.web}`);
  });

  test('shared primary Supabase creds use standard local ports when status is unavailable', () => {
    const creds = primaryCredsFromStatus({});
    expect(creds.dbUrl).toContain(`127.0.0.1:${SHARED_SUPABASE_PORTS.sbDb}`);
    expect(creds.supabaseUrl).toBe(`http://127.0.0.1:${SHARED_SUPABASE_PORTS.sbApi}`);
  });

  test('no launch-env value is ever the string "undefined" (a missing port stringifies to "undefined")', () => {
    for (let slot = 0; slot < 6; slot++) {
      const p = computePorts(slot);
      const c = slotCredsFromStatus(p, {});
      const envs = [apiLaunchEnv(p, c), gatewayLaunchEnv(p), webLaunchEnv(p, c)];
      for (const env of envs) {
        for (const [k, v] of Object.entries(env)) {
          expect(v, `slot ${slot} ${k}="${v}"`).not.toContain('undefined');
        }
      }
    }
  });

  test('computePorts(slot) always carries the gateway port (the field whose absence caused the 8090 fallback)', () => {
    for (let slot = 0; slot < 6; slot++) {
      expect(typeof computePorts(slot).gateway).toBe('number');
      expect(gatewayLaunchEnv(computePorts(slot)).PORT).toMatch(/^\d+$/);
    }
  });
});
