import { expect, test } from 'bun:test';
import type { AgentCapabilities as ApiCatalog } from './agent-capabilities';
import type { AgentCapabilities as SdkCatalog } from '@kortix/sdk';

const wire: ApiCatalog = {
  agent: 'synthetic', schema_version: 7,
  tools: [{ id: 'agent', group: 'interaction', description: null, aliases: ['task'], source: null }],
  skills: [{ id: 'skill', group: 'project', description: null, feature_flag: null, available: false }],
  extensions: [{ id: 'extension', group: 'platform', description: null, required: true, controlled_by: null }],
};
const toSdk = (catalog: ApiCatalog): SdkCatalog => catalog;
const toApi = (catalog: SdkCatalog): ApiCatalog => catalog;

test('API and SDK capability wire catalogs are assignable in both directions without conversion', () => {
  expect(toApi(toSdk(wire))).toBe(wire);
  const sdk: SdkCatalog = {
    ...wire,
    tools: [{ id: 'lookup', group: 'project', description: 'Lookup', aliases: [], source: 'tools/lookup.ts' }],
    skills: [{ id: 'skill', group: 'builtin', description: 'Skill', feature_flag: 'enabled', available: true }],
    extensions: [{ id: 'extension', group: 'project', description: 'Extension', required: false, controlled_by: 'agent' }],
  };
  expect(toSdk(toApi(sdk))).toBe(sdk);
});
