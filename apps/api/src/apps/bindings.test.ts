import { describe, expect, test } from 'bun:test';
import { parseBindingPath } from './bindings';

describe('the bindings mount path', () => {
  test('strips /_kortix/apps/<slug> and keeps the rest of the path', () => {
    expect(parseBindingPath('/_kortix/apps/db/api/1.46.0/sync')).toEqual({ name: 'db', path: '/api/1.46.0/sync' });
    expect(parseBindingPath('/_kortix/apps/db/')).toEqual({ name: 'db', path: '/' });
    expect(parseBindingPath('/_kortix/apps/db')).toEqual({ name: 'db', path: '/' });
  });

  test('a percent-encoded slug decodes; a malformed one, an empty one and any other path are not a binding', () => {
    expect(parseBindingPath('/_kortix/apps/my%2Ddb/x')).toEqual({ name: 'my-db', path: '/x' });
    expect(parseBindingPath('/_kortix/apps/%E0%A4%A/x')).toBeNull();
    expect(parseBindingPath('/_kortix/apps/')).toBeNull();
    expect(parseBindingPath('/_kortix/apps//x')).toBeNull();
    expect(parseBindingPath('/_kortix/token')).toBeNull();
    expect(parseBindingPath('/api/_kortix/apps/db')).toBeNull();
  });
});
