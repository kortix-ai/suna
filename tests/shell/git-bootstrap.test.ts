import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// Explicit Docker contract, not a unit-suite dependency. Run with bun test.
// Execute the real workflow shell in an Ubuntu image with empty apt indexes.
test('Git bootstrap works on a clean Ubuntu runner', () => {
  const workflow = Bun.YAML.parse(
    readFileSync(new URL('../../.github/workflows/tests.yml', import.meta.url), 'utf8'),
  );
  if (!workflow || typeof workflow !== 'object' || !('jobs' in workflow)) throw new Error('Missing jobs');
  const jobs = workflow.jobs;
  if (!jobs || typeof jobs !== 'object' || !('lane' in jobs)) throw new Error('Missing lane');
  const lane = jobs.lane;
  if (!lane || typeof lane !== 'object' || !('steps' in lane) || !Array.isArray(lane.steps)) throw new Error('Missing steps');
  const step = lane.steps.find(entry => entry?.name === 'Install git 2.45 or later');
  if (typeof step?.run !== 'string') throw new Error('Missing Git bootstrap');
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
