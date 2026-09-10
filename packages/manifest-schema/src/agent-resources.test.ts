import { expect, test } from 'bun:test';
import { validateManifest } from './index';
import Ajv from 'ajv';
import { agentResourcesSchema } from './agent-resources';

const manifest = (resources: unknown) =>
  JSON.stringify({
    kortix_version: 3,
    default_agent: 'reporter',
    agents: { reporter: { resources } },
  });

test('agent resources accept explicit worker files and environment destinations', () => {
  expect(
    validateManifest(
      manifest({
        worker: { rules: 'assets/rules.json' },
        environment: [
          { source: 'assets/template.txt', target: '/workspace/template.txt', mode: 'seed' },
        ],
      }),
      'yaml',
    ).valid,
  ).toBe(true);
});

test('OpenCode resource declarations fail explicitly until its resource adapter exists', () => {
  const result = validateManifest(
    manifest({ worker: { rules: 'rules.json' } }).replace(
      '"kortix_version":3',
      '"kortix_version":2',
    ),
    'yaml',
  );
  expect(result.valid).toBe(false);
  expect(
    result.issues.some(
      (issue) => issue.path === 'agents.reporter.resources' && issue.message.includes('OpenCode'),
    ),
  ).toBe(true);
});

test.each([
  { worker: { rules: '../private.json' } },
  { worker: { rules: '/etc/passwd' } },
  { worker: { rules: '.env' } },
  { worker: { rules: 'assets/.env.local' } },
  { worker: { rules: 'assets/.git/config' } },
  { worker: { rules: ' file.json' } },
  { worker: { rules: 'file.json ' } },
  { worker: { rules: 'assets//x' } },
  { worker: { rules: 'assets/./x' } },
  { worker: { rules: 'assets/../x' } },
  { worker: { rules: 'assets\\x' } },
  { worker: { rules: 'assets/\u007f' } },
  { worker: { '../rules': 'assets/rules.json' } },
  { worker: { rules: true } },
  { environment: [{ source: 'x', target: '/etc/passwd', mode: 'seed' }] },
  { environment: [{ source: 'x', target: '/workspace/../etc/passwd', mode: 'seed' }] },
  { environment: [{ source: 'x', target: '/workspace/x', mode: 'replace' }] },
  { environment: [{ source: 'x', target: '/workspace/x', mode: 'read_only' }] },
  { environment: [{ source: 'x', target: '/opt/kortix/helpers/x', mode: 'seed' }] },
  {
    environment: [
      { source: 'x', target: '/workspace/a', mode: 'seed' },
      { source: 'y', target: '/workspace/a/b', mode: 'seed' },
    ],
  },
  {
    environment: [
      { source: 'x', target: '/workspace/x', mode: 'seed' },
      { source: 'y', target: '/workspace/x', mode: 'seed' },
    ],
  },
  { unexpected: {} },
])('agent resource declarations reject unsafe or unsupported values: %j', (resources) => {
  const result = validateManifest(manifest(resources), 'yaml');
  expect(result.valid).toBe(false);
  expect(result.issues.some((issue) => issue.path.startsWith('agents.reporter.resources'))).toBe(
    true,
  );
});

test('generated JSON schema rejects traversal, secrets, whitespace and incompatible placement', () => {
  const validate = new Ajv().compile(agentResourcesSchema());
  for (const source of [
    '../x',
    '/x',
    '.env',
    'a/.git/config',
    'a/.env.prod',
    ' x',
    'x ',
    'a//b',
    'a\\b',
    'a/\u007f',
  ])
    expect(validate({ worker: { rules: source } })).toBe(false);
  for (const [mode, target] of [
    ['seed', '/workspace/../x'],
    ['seed', '/opt/kortix/helpers/x'],
    ['read_only', '/workspace/x'],
  ])
    expect(validate({ environment: [{ source: 'x', mode, target }] })).toBe(false);
  expect(
    validate({
      worker: { rules: 'assets/rules.json' },
      environment: [{ source: 'x', mode: 'read_only', target: '/opt/kortix/helpers/check.py' }],
    }),
  ).toBe(true);
});
