import { describe, expect, test } from 'bun:test';

import { parseUpdaterArtifact } from '../launcher.ts';

describe('immutable updater launcher contract', () => {
  test('extracts only an exact TUF-cross-checked updater artifact', () => {
    const artifact = parseUpdaterArtifact({
      future_schema_field: { safely: 'ignored by bootstrap launcher' },
      artifacts: {
        updater_binary: {
          target: 'releases/0.9.84-e1/updater-linux-amd64',
          sha256: 'a'.repeat(64),
          length: 1234,
        },
      },
    });
    expect(artifact).toEqual({
      target: 'releases/0.9.84-e1/updater-linux-amd64',
      sha256: 'a'.repeat(64),
      length: 1234,
    });
  });

  test('rejects traversal and unexpected updater contract fields', () => {
    expect(() => parseUpdaterArtifact({
      artifacts: { updater_binary: { target: '../updater', sha256: 'a'.repeat(64), length: 1 } },
    })).toThrow('updater_binary contract is invalid');
    expect(() => parseUpdaterArtifact({
      artifacts: {
        updater_binary: { target: 'updater', sha256: 'a'.repeat(64), length: 1, url: 'https://evil.example' },
      },
    })).toThrow('updater_binary contract is invalid');
  });
});
