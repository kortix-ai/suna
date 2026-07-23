import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  compatibleHarnessesWithoutActiveRoute,
  PROJECT_PROVIDER_CONNECTIONS,
  secretWritesForConnection,
} from './project-provider-auth';

const here = dirname(fileURLToPath(import.meta.url));

test('subscription and API-key connections stay distinct per vendor', () => {
  const byId = new Map(PROJECT_PROVIDER_CONNECTIONS.map((entry) => [entry.id, entry]));

  assert.equal(byId.get('claude_subscription')?.mode, 'token');
  assert.deepEqual(byId.get('claude_subscription')?.secretNames, ['CLAUDE_CODE_OAUTH_TOKEN']);
  assert.equal(byId.get('anthropic_api_key')?.mode, 'api-key');
  assert.deepEqual(byId.get('anthropic_api_key')?.secretNames, ['ANTHROPIC_API_KEY']);

  assert.equal(byId.get('codex_subscription')?.mode, 'oauth');
  assert.deepEqual(byId.get('codex_subscription')?.secretNames, ['CODEX_AUTH_JSON']);
  assert.equal(byId.get('openai_api_key')?.mode, 'api-key');
  assert.deepEqual(byId.get('openai_api_key')?.secretNames, ['OPENAI_API_KEY']);
});

test('project credential writes use platform secret names only', () => {
  assert.deepEqual(secretWritesForConnection('claude_subscription', ' claude-token '), [
    { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'claude-token' },
  ]);
  assert.deepEqual(secretWritesForConnection('openai_api_key', ' sk-openai '), [
    { name: 'OPENAI_API_KEY', value: 'sk-openai' },
  ]);
  assert.throws(
    () => secretWritesForConnection('codex_subscription', 'not-an-api-key'),
    /OAuth flow/,
  );
});

test('connecting a credential never steals an explicitly active harness route', () => {
  const target = PROJECT_PROVIDER_CONNECTIONS.find((entry) => entry.id === 'openai_api_key');
  assert.ok(target);
  assert.deepEqual(
    compatibleHarnessesWithoutActiveRoute(target, [
      { id: 'managed_gateway', active_for: ['opencode'] },
      { id: 'codex_subscription', active_for: ['codex'] },
    ]),
    ['pi'],
  );
});

test('mobile provider surfaces contain no native OpenCode provider/config transport', () => {
  const files = [
    resolve(here, '../../components/setup/SetupWizard.tsx'),
    resolve(here, '../../components/pages/LlmProvidersPage.tsx'),
  ];
  const forbidden = [
    '/provider/auth',
    '/oauth/authorize',
    '/oauth/callback',
    '/global/config',
    '/global/dispose',
  ];

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const endpoint of forbidden) {
      assert.equal(source.includes(endpoint), false, `${file} still references ${endpoint}`);
    }
    assert.equal(
      /\/auth\/\$\{encodeURIComponent\(providerId\)\}/.test(source),
      false,
      `${file} still writes native provider auth`,
    );
  }
});

test('mobile onboarding uses server-authoritative composer models and no native command endpoint', () => {
  const wizard = readFileSync(
    resolve(here, '../../components/setup/SetupWizard.tsx'),
    'utf8',
  );
  const onboarding = readFileSync(
    resolve(here, '../../components/setup/InstanceOnboarding.tsx'),
    'utf8',
  );

  assert.equal(wizard.includes('useComposerModelCatalog'), true);
  assert.equal(wizard.includes('useRuntimeProviders'), false);
  assert.equal(onboarding.includes('/session/${session.id}/command'), false);
  assert.equal(onboarding.includes("initialPrompt: '/onboarding'"), true);
});
