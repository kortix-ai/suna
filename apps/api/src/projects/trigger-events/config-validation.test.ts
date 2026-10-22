import { describe, expect, test } from 'bun:test';
import { eventConfigProblem, validateEventConfig } from './config-validation';
import type { EventTypeInfo } from './types';

const schema = {
  type: 'object',
  required: ['repo'],
  properties: {
    repo: { type: 'string', description: 'Repository as owner/name.' },
    interval: { type: 'integer', description: 'Minutes between polls.' },
    state: { type: 'string', enum: ['open', 'closed'] },
    labels: { type: 'array' },
    draft: { type: 'boolean' },
  },
};

describe('validateEventConfig', () => {
  test('accepts a valid config and unknown fields', () => {
    expect(validateEventConfig(schema, { repo: 'acme/api', interval: 5, extra: 1 })).toEqual([]);
  });
  test('names a missing required field and quotes its description', () => {
    expect(validateEventConfig(schema, {})).toEqual(['repo is required (Repository as owner/name.)']);
    expect(validateEventConfig(schema, { repo: '' })).toHaveLength(1);
  });
  test('rejects wrong primitive types', () => {
    const errors = validateEventConfig(schema, { repo: 5, interval: 1.5, labels: 'x', draft: 'yes' });
    expect(errors).toEqual([
      'repo must be string (Repository as owner/name.)',
      'interval must be integer (Minutes between polls.)',
      'labels must be array',
      'draft must be boolean',
    ]);
  });
  test('rejects a value outside the enum', () => {
    expect(validateEventConfig(schema, { repo: 'a/b', state: 'merged' })).toEqual(['state must be one of "open", "closed"']);
  });
  test('tolerates an empty or odd schema', () => {
    expect(validateEventConfig({}, { a: 1 })).toEqual([]);
    expect(validateEventConfig({ properties: { a: { type: ['string', 'null'] } } }, { a: 1 })).toEqual(['a must be string or null']);
  });
});

describe('eventConfigProblem', () => {
  const items = [{ type: 'GITHUB_PR', configSchema: schema }] as unknown as EventTypeInfo[];
  test('unknown event points at the catalog command', () => {
    expect(eventConfigProblem(items, 'github', 'GITHUB_X', {})).toBe(
      'Unknown event GITHUB_X for github. Run kortix triggers events --connector github.',
    );
  });
  test('valid and invalid configs', () => {
    expect(eventConfigProblem(items, 'github', 'GITHUB_PR', { repo: 'a/b' })).toBeNull();
    expect(eventConfigProblem(items, 'github', 'GITHUB_PR', {})).toBe('Invalid config for GITHUB_PR: repo is required (Repository as owner/name.).');
  });
});

describe('freeConnectorSlug', () => {
  test('uses the app name unless it is reserved or taken', async () => {
    const { freeConnectorSlug } = await import('./catalog');
    expect(freeConnectorSlug('github', [])).toBe('github');
    expect(freeConnectorSlug('github', ['github'])).toBe('github-events');
    expect(freeConnectorSlug('github', ['github', 'github-events'])).toBe('github-events-2');
    expect(freeConnectorSlug('slack', [])).toBe('slack-events');
  });
});
