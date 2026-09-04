import { expect, test } from 'bun:test';
import { extractConnectors } from '../projects/connectors';
import { connectorConfig } from './materialize';

test('connectorConfig persists the Composio toolkit used by connect and execution', () => {
  const loaded = extractConnectors({
    schemaVersion: 2,
    format: 'yaml',
    path: 'kortix.yaml',
    raw: {
      connectors: [
        {
          slug: 'search',
          provider: 'composio',
          app: 'composio_search',
          auth: { type: 'none' },
        },
      ],
    },
  });

  expect(loaded.errors).toEqual([]);
  expect(loaded.specs).toHaveLength(1);
  expect(connectorConfig(loaded.specs[0]!)).toMatchObject({
    app: 'composio_search',
    account: 'search',
  });
});
