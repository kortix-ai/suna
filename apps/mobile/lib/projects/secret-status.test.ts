import { describe, expect, test } from 'bun:test';

import type { ProjectSecret } from './projects-client';
import { secretStatusText, secretUndecryptable } from './secret-status';

function secret(fields: Partial<ProjectSecret>): ProjectSecret {
  return {
    identifier: 'OPENAI_API_KEY',
    name: 'OPENAI_API_KEY',
    project_id: 'p1',
    secret_id: 's1',
    created_by: null,
    created_at: null,
    updated_at: null,
    configured: true,
    mine: null,
    effective_source: 'shared',
    can_manage_shared: true,
    ...fields,
  };
}

const MINE = { active: true, updated_at: '2026-10-13T00:00:00.000Z' };

describe('secretStatusText (KRTX-1719)', () => {
  test('a shared value the server cannot decrypt reads as such, not as in use', () => {
    const s = secret({ status: 'undecryptable' });
    expect(secretUndecryptable(s)).toBe(true);
    expect(secretStatusText(s)).toBe('Shared value cannot be decrypted');
  });

  test('a broken active override decides, even when the shared value decrypts', () => {
    const s = secret({ status: 'ok', effective_source: 'mine', mine: { ...MINE, status: 'undecryptable' } });
    expect(secretUndecryptable(s)).toBe(true);
    expect(secretStatusText(s)).toBe('Your own value cannot be decrypted');
  });

  test('decryptable values, and servers that do not report status, read as before', () => {
    expect(secretStatusText(secret({ status: 'ok' }))).toBe('Using the shared value');
    expect(secretStatusText(secret({}))).toBe('Using the shared value');
    expect(secretStatusText(secret({ effective_source: 'mine', mine: { ...MINE, status: 'ok' } }))).toBe(
      'Using your own value',
    );
    expect(secretStatusText(null)).toBe('Not set');
    expect(secretUndecryptable(secret({ configured: false, effective_source: 'none' }))).toBe(false);
  });
});
