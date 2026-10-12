import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflows = resolve(import.meta.dirname, '../../.github/workflows');
const read = (name: string) => readFileSync(resolve(workflows, name), 'utf8');

/** Split a workflow into `{ jobId: text }` using the 2-space job keys under `jobs:`. */
function jobs(source: string): Record<string, string> {
  const lines = source.split('\n');
  const start = lines.indexOf('jobs:');
  const out: Record<string, string> = {};
  let id = '';
  for (const line of lines.slice(start + 1)) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) {
      id = m[1];
      out[id] = '';
    } else if (id) out[id] += `${line}\n`;
  }
  return out;
}

/**
 * Incident 2026-10-11: a failed Deploy Prod left the CRITICAL "Release in
 * progress" banner up 8 h 27 min, because the lowering job ran only on success.
 */
describe('deploy-prod rollout banner', () => {
  const all = jobs(read('deploy-prod.yml'));

  it('lowers the banner on success, failure and cancel', () => {
    const off = all['maintenance-banner-off'];
    expect(off).toMatch(/^ {4}if: \$\{\{ always\(\) \}\}$/m);
    expect(off).toMatch(/needs: \[[^\]]*maintenance-banner-on[^\]]*\]/);
    expect(off).toMatch(/needs: \[[^\]]*deploy-ecs[^\]]*\]/);
  });

  it('raises the banner only after the same gates as deploy-ecs', () => {
    const on = all['maintenance-banner-on'];
    for (const gate of ['retag-images', 'verify-image-commits', 'migrate-db', 'terraform-prod-api', 'terraform-prod']) {
      expect(on).toMatch(new RegExp(`needs: \\[[^\\]]*\\b${gate}\\b[^\\]]*\\]`));
    }
    expect(on).toContain("needs.migrate-db.result == 'success'");
  });

  it('never fails the run when the banner endpoint is down', () => {
    expect(all['maintenance-banner-off']).toMatch(/Lower rollout banner\n\s+if: [^\n]+\n\s+continue-on-error: true/);
  });
});

describe('deploy workflows bound every job', () => {
  for (const name of [
    'deploy-prod.yml',
    'deploy-staging.yml',
    'deploy-dev.yml',
    'build-staging.yml',
    'rollback-prod.yml',
    'promote.yml',
    'deploy-preview.yml',
  ]) {
    it(`${name}: every non-reusable job sets timeout-minutes`, () => {
      const missing = Object.entries(jobs(read(name)))
        .filter(([, text]) => !/^ {4}uses:/m.test(text))
        .filter(([, text]) => !/^ {4}timeout-minutes: \d+$/m.test(text))
        .map(([id]) => id);
      expect(missing).toEqual([]);
    });
  }
});

/** The API and gateway roll read nothing the web Terraform root creates. */
describe('web Terraform root does not gate the API roll', () => {
  const needsOf = (text: string) => /^ {4}needs: \[([^\]]*)\]/m.exec(text)?.[1] ?? '';

  it('prod: deploy-ecs skips terraform-prod, deploy-web-ecs waits for it', () => {
    const all = jobs(read('deploy-prod.yml'));
    expect(needsOf(all['deploy-ecs'])).not.toContain('terraform-prod,');
    expect(needsOf(all['deploy-ecs']).split(', ')).not.toContain('terraform-prod');
    expect(needsOf(all['deploy-web-ecs']).split(', ')).toContain('terraform-prod');
  });

  it('dev: deploy-api-ecs skips terraform-dev, deploy-web-ecs waits for it', () => {
    const all = jobs(read('deploy-dev.yml'));
    expect(needsOf(all['deploy-api-ecs']).split(', ')).not.toContain('terraform-dev');
    expect(needsOf(all['deploy-web-ecs']).split(', ')).toContain('terraform-dev');
  });
});

/**
 * 2026-10-12: staging rolled web only after the API and gateway (7.4 + 3.5 min
 * serial). Staging now rolls them in parallel; prod keeps web after API.
 */
describe('web rollout order', () => {
  const needs = (job: string) => /^ {4}needs: \[(.*)\]$/m.exec(job)?.[1].split(', ') ?? [];

  it('staging rolls web in parallel with the API, and verify still waits for the API', () => {
    const staging = jobs(read('deploy-staging.yml'));
    expect(needs(staging['deploy-web-ecs'])).not.toContain('deploy-ecs');
    expect(needs(staging['deploy-web-vercel'])).not.toContain('deploy-ecs');
    expect(needs(staging.verify)).toContain('deploy-ecs');
    expect(needs(staging['promote-staging-channel'])).toContain('verify');
  });

  it('prod keeps web after the API roll', () => {
    expect(needs(jobs(read('deploy-prod.yml'))['deploy-web-ecs'])).toContain('deploy-ecs');
  });
});
