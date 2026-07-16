import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saveAuthForHost } from '../api/auth.ts';
import { getHost, loadConfig, upsertHost } from '../api/config.ts';
import { webDashboardUrl } from '../web-url.ts';

// Regression coverage for the self-host login bug: `kortix login` used to
// derive the frontend/dashboard URL purely from the API URL's shape, which
// assumes cloud conventions (`api.<domain>` → `<domain>`) and a fixed local
// dev port pairing (`:8008` → `:3000`). Neither holds for `kortix self-host`,
// whose laptop default is API `:13738` / dashboard `:13737` — so the browser
// flow opened a dead `:3000` with nothing listening on it. The fix: an
// authoritative `dashboard_url` on the `Host` record (stamped by
// `kortix self-host` from its own `PUBLIC_URL`, or settable via
// `kortix hosts add --dashboard-url`) that `webDashboardUrl` prefers over
// any guess.

const SAVED = { ...process.env };
let tmp: string;

beforeEach(() => {
  delete process.env.KORTIX_FRONTEND_URL;
  delete process.env.KORTIX_DASHBOARD_URL;
  delete process.env.BASH_ENV;
  process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
  tmp = mkdtempSync(join(tmpdir(), 'kortix-cli-host-dashboard-'));
  process.env.KORTIX_CONFIG_FILE = join(tmp, 'config.json');
});

afterEach(() => {
  process.env = { ...SAVED };
  rmSync(tmp, { recursive: true, force: true });
});

describe('webDashboardUrl — explicit dashboard_url override', () => {
  test('self-host laptop default: API :13738 / dashboard :13737 — derivation would guess :3000 and be wrong', () => {
    // Sanity: this is exactly the bug — the API-shape guess assumes the
    // pnpm-dev :8008 → :3000 pairing and has no way to know a self-host
    // stack's actual dashboard port.
    expect(webDashboardUrl('http://localhost:13738')).toBe('http://localhost:3000');
    // With the authoritative value (what `kortix self-host` now stamps on
    // the host record), it resolves correctly instead.
    expect(webDashboardUrl('http://localhost:13738', 'http://localhost:13737')).toBe(
      'http://localhost:13737',
    );
  });

  test('explicit override wins over KORTIX_FRONTEND_URL / KORTIX_DASHBOARD_URL', () => {
    process.env.KORTIX_FRONTEND_URL = 'https://wrong.example.com';
    expect(webDashboardUrl('http://localhost:13738', 'http://localhost:13737')).toBe(
      'http://localhost:13737',
    );
  });

  test('blank/whitespace override falls through to derivation, not a dead link', () => {
    expect(webDashboardUrl('http://localhost:8008', '')).toBe('http://localhost:3000');
    expect(webDashboardUrl('http://localhost:8008', '   ')).toBe('http://localhost:3000');
  });

  test('trailing slash on the override is stripped, same as every other path', () => {
    expect(webDashboardUrl('http://localhost:13738', 'http://localhost:13737/')).toBe(
      'http://localhost:13737',
    );
  });

  test('domain self-host deployment still resolves without an explicit override (api.<domain> → <domain>)', () => {
    // The domain case was already correct — PUBLIC_URL/API_PUBLIC_URL both
    // derive from KORTIX_DOMAIN in self-host.ts's normalizeFullSupabaseEnv,
    // and api.<domain> → <domain> is exactly what deriveFrontendFromApiBase
    // already handles. No regression here.
    expect(webDashboardUrl('https://api.example.com')).toBe('https://example.com');
  });
});

describe('Host.dashboard_url — persists through the config file round trip', () => {
  test('upsertHost → loadConfig → getHost carries dashboard_url through normalizeConfig', () => {
    upsertHost(
      'selfhost',
      {
        url: 'http://localhost:13738',
        token: '',
        user_id: '',
        user_email: '',
        account_id: '',
        dashboard_url: 'http://localhost:13737',
        logged_in_at: new Date().toISOString(),
      },
      true,
    );

    const reloaded = getHost('selfhost');
    expect(reloaded?.dashboard_url).toBe('http://localhost:13737');

    // And it survives a raw JSON round trip too (normalizeConfig's cleaning
    // pass — the same path a real ~/.config/kortix/config.json goes through).
    const config = loadConfig();
    expect(config.hosts.selfhost?.dashboard_url).toBe('http://localhost:13737');
  });

  test('saveAuthForHost (what `kortix login` calls to persist a fresh token) does NOT wipe dashboard_url', () => {
    // Regression: authToHost() used to rebuild the Host record from scratch
    // on every login, dropping any field the `Auth` shape doesn't carry.
    // dashboard_url has no other call site that re-derives it after login
    // (unlike account_slug/default_project, which login.ts re-sets right
    // after via setActiveAccount/ensureDefaultProjectBinding) — so the very
    // first successful `kortix login` against a `kortix self-host`-registered
    // host silently erased the authoritative frontend URL, and the NEXT
    // `kortix login` (e.g. after `kortix logout` + `kortix login` again) was
    // right back to guessing :3000.
    upsertHost(
      'selfhost',
      {
        url: 'http://localhost:13738',
        token: '',
        user_id: '',
        user_email: '',
        account_id: '',
        dashboard_url: 'http://localhost:13737',
        logged_in_at: new Date().toISOString(),
      },
      true,
    );

    saveAuthForHost(
      'selfhost',
      {
        api_base: 'http://localhost:13738',
        token: 'kortix_pat_fresh',
        user_id: 'user_1',
        user_email: 'user@example.test',
        account_id: 'account_1',
        logged_in_at: new Date().toISOString(),
      },
      true,
    );

    const host = getHost('selfhost');
    expect(host?.token).toBe('kortix_pat_fresh');
    expect(host?.user_email).toBe('user@example.test');
    expect(host?.dashboard_url).toBe('http://localhost:13737');
  });

  test('a host with no dashboard_url (e.g. cloud, manually-added hosts) omits the field rather than defaulting to empty string', () => {
    writeFileSync(
      process.env.KORTIX_CONFIG_FILE!,
      JSON.stringify({
        active: 'cloud',
        hosts: {
          cloud: {
            url: 'https://api.kortix.com',
            token: 'kortix_pat_x',
            user_id: 'u1',
            user_email: 'a@b.com',
            account_id: 'acc1',
            logged_in_at: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
    );
    const host = getHost('cloud');
    expect(host?.dashboard_url).toBeUndefined();
  });
});
