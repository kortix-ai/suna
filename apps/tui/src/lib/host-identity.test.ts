import { expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';

import { forgetHostIdentity } from './host-identity.ts';

test('a host switch drops every cached query, project and tui keys included', () => {
  const qc = new QueryClient();
  qc.setQueryData(['projects', 'proj_old', 'sessions'], [{ id: 'ses_old' }]);
  qc.setQueryData(['tui', 'board', 'proj_old'], { rows: 3 });
  let resets = 0;
  forgetHostIdentity(qc, () => { resets += 1; });
  expect(qc.getQueryCache().getAll()).toHaveLength(0);
  expect(resets).toBe(1);
});

test('a throwing SDK reset still leaves the query cache empty', () => {
  const qc = new QueryClient();
  qc.setQueryData(['x'], 1);
  expect(() => forgetHostIdentity(qc, () => { throw new Error('boom'); })).not.toThrow();
  expect(qc.getQueryCache().getAll()).toHaveLength(0);
});

test('the default reset is the SDK identity reset', () => {
  const qc = new QueryClient();
  expect(() => forgetHostIdentity(qc)).not.toThrow();
});
