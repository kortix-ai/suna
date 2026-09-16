import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compilePiRuntime } from './compiled-pi-runtime';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('compiled Pi skill payload', () => {
  test('bakes approved skills into the manifest and worker global', () => {
    const skills = [
      {
        name: 'release',
        description: 'Prepare a release',
        location: '.kortix/pi/skills/release/SKILL.md',
        content: 'Release instructions.',
        files: ['scripts/release.ts'],
      },
    ];
    const artifact = compilePiRuntime({
      projectId: 'project-skill',
      ref: 'main',
      sourceSha: 'd'.repeat(40),
      agentConfig: null,
      defaultAgent: 'build',
      skills,
      workerBundle:
        'console.log(JSON.stringify(globalThis.__KORTIX_COMPILED__.skills));\nprocess.exit(0);\n',
    });

    expect(JSON.parse(artifact.manifest.skill_config ?? 'null')).toEqual(skills);
    expect(artifact.manifest.skill_config_etag).toMatch(/^[0-9a-f]{16}$/);

    const root = mkdtempSync(join(tmpdir(), 'kortix-pi-skill-runtime-'));
    roots.push(root);
    const path = join(root, 'worker.mjs');
    writeFileSync(path, artifact.source, { mode: 0o700 });
    expect(JSON.parse(execFileSync(process.execPath, [path], { encoding: 'utf8' }))).toEqual(
      skills,
    );
  });

  test('skill bytes participate in the artifact identity', () => {
    const base = {
      projectId: 'project-skill',
      ref: 'main',
      sourceSha: 'd'.repeat(40),
      agentConfig: null,
      defaultAgent: 'build',
      workerBundle: 'process.exit(0);',
    };
    const first = compilePiRuntime({
      ...base,
      skills: [{ name: 'release', location: 'a/SKILL.md', content: 'old', files: [] }],
    });
    const second = compilePiRuntime({
      ...base,
      skills: [{ name: 'release', location: 'a/SKILL.md', content: 'new', files: [] }],
    });

    expect(second.sha256).not.toBe(first.sha256);
  });
});
