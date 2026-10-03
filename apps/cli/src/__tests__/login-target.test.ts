import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const entry = join(import.meta.dir, '..', 'index.ts');

describe('browser login target', () => {
  for (const scenario of [
    { api: 'https://dev-api.kortix.com', expected: 'https://dev.kortix.com' },
    { api: 'https://staging-api.kortix.com/v1', expected: 'https://staging.kortix.com' },
    { api: 'https://api.kortix.com', expected: 'https://kortix.com' },
    { api: 'http://localhost:8008', expected: 'http://localhost:3000' },
    { api: 'http://localhost:13738', dashboard: 'http://localhost:13737/', expected: 'http://localhost:13737' },
    { api: 'https://api.kortix.com', dashboard: 'https://kortix.com', override: 'https://dev-api.kortix.com', expected: 'https://dev.kortix.com' },
    { api: 'http://localhost:13738', dashboard: 'http://localhost:13737', override: 'http://localhost:13738/v1/', expected: 'http://localhost:13737' },
  ]) {
    test(`opens ${scenario.expected} despite unrelated frontend environment`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'login-target-'));
      const config = join(dir, 'config.json');
      writeFileSync(config, JSON.stringify({ active: 'target', hosts: { target: {
        url: scenario.api, token: '', user_id: '', user_email: '', account_id: '',
        logged_in_at: '', dashboard_url: scenario.dashboard,
      } } }));
      const args = ['login', '--host', 'target', '--no-project'];
      if (scenario.override) args.push('--api', scenario.override);
      const proc = Bun.spawn([process.execPath, entry, ...args], {
        env: { ...process.env, CI: '1', KORTIX_CONFIG_FILE: config,
          KORTIX_FRONTEND_URL: 'https://unrelated.example.test',
          KORTIX_DASHBOARD_URL: 'https://legacy.example.test',
          KORTIX_DISABLE_SANDBOX_ENV_FILE: '1', KORTIX_NO_UPDATE_CHECK: '1' },
        stdout: 'pipe', stderr: 'pipe',
      });
      const timer = setTimeout(() => proc.kill(), 10000);
      try {
        const reader = proc.stdout.getReader();
        let output = '';
        while (!output.includes('/cli/authorize?')) {
          const chunk = await reader.read();
          if (chunk.done) break;
          output += new TextDecoder().decode(chunk.value);
        }
        expect(output).toContain(`${scenario.expected}/cli/authorize?`);
        expect(output).not.toContain('unrelated.example.test');
        expect(output).not.toContain('legacy.example.test');
      } finally {
        clearTimeout(timer);
        proc.kill();
        await proc.exited;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
