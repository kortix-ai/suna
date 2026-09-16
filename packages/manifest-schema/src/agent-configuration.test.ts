import { expect, test } from 'bun:test';
import Ajv2020 from 'ajv/dist/2020';
import { validateManifest } from './index';
import { KORTIX_JSON_SCHEMA } from './json-schema';

const json = new Ajv2020({ strict: false, allErrors: true }).compile(KORTIX_JSON_SCHEMA);
const manifest = (version: number, config: unknown, configDir: unknown = '.kortix/shared') => ({
  kortix_version: version,
  config_dir: configDir,
  default_agent: 'reviewer',
  agents: { reviewer: { skills: 'none', config } },
});

test.each([2, 3])(
  'version %s accepts the same explicit agent settings and prompt file',
  (version) => {
    const value = manifest(version, {
      model: 'kortix/gpt-5.6-luna',
      description: 'Review changes',
      temperature: 0.2,
      prompt: { file: 'agents/reviewer.md' },
      permission: { '*': 'deny', read: 'allow' },
      pi: { source: 'agents/reviewer.ts' },
    });
    expect(
      validateManifest(value, 'yaml').issues.filter((issue) => issue.severity === 'error'),
    ).toEqual([]);
    expect(json(value)).toBe(true);
  },
);

test.each(
  [
    null,
    [],
    { model: 42 },
    { temperatuer: 1 },
    { prompt: 2 },
    { prompt: { file: '../secret' } },
    { prompt: { file: '.env.local' } },
    { prompt: { file: 'agents/a.md', fallback: 'hidden' } },
    { pi: { source: 'agents/a.ts', unknown: true } },
    { pi: { source: '/tmp/a.ts' } },
    { pi: { source: 'agents/a.py' } },
    { pi: null },
  ].map((config) => [config] as const),
)('both validators reject malformed agent configuration %j', (config) => {
  for (const version of [2, 3]) {
    const value = manifest(version, config);
    expect(validateManifest(value, 'yaml').issues.some((issue) => issue.severity === 'error')).toBe(
      true,
    );
    expect(json(value)).toBe(false);
  }
});

test.each(['../outside', '/tmp/config', '.env', 'config\\outside', ' config', null])(
  'rejects unsafe shared config directory %j',
  (configDir) => {
    const value = manifest(3, { prompt: 'Review changes.' }, configDir);
    expect(
      validateManifest(value, 'yaml').issues.some(
        (issue) => issue.path === 'config_dir' && issue.severity === 'error',
      ),
    ).toBe(true);
    expect(json(value)).toBe(false);
  },
);
