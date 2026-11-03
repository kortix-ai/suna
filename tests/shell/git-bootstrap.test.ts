import { expect, test } from 'bun:test';

// Explicit Docker contract, not a unit-suite dependency. Run with bun test.
// Execute the real workflow shell in an Ubuntu image with empty apt indexes.
test('Git bootstrap works on a clean Ubuntu runner', () => {
  const workflow = Bun.YAML.parse(
    require('node:fs').readFileSync(new URL('../../.github/workflows/tests.yml', import.meta.url), 'utf8'),
  );
  const step = workflow.jobs.lane.steps.find(
    (entry: { name?: string }) => entry.name === 'Install git 2.45 or later',
  );
  expect(typeof step?.run).toBe('string');
  const result = Bun.spawnSync([
    'docker', 'run', '--rm', 'ubuntu:24.04', 'bash', '-ec',
    `apt-get update -qq
apt-get install -y -qq --no-install-recommends git ca-certificates
rm -rf /var/lib/apt/lists/*
sudo() { "$@"; }
${step.run}\ngit --version | awk '{ split($3,v,"."); exit !(v[1]>2 || (v[1]==2 && v[2]>=45)) }'`,
  ], { stdout: 'pipe', stderr: 'pipe', timeout: 300_000 });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
}, 310_000);
