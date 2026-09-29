import { describe, expect, test } from 'bun:test';
import { resolveSecretWriteInput } from './secret-write-input';

// `MS_TEAMS_TENANT_ID` once chose whose Microsoft Graph data the Teams
// connector read, with the managed app every customer shares. A project writer
// could set it to another customer's tenant through this API (2026-09-29
// permissions audit). The Teams connection owns every `MS_TEAMS_*` name.
describe('resolveSecretWriteInput: names another part of Kortix owns', () => {
  test.each(['MS_TEAMS_TENANT_ID', 'ms_teams_app_password', 'MS_TEAMS_SERVICE_URL'])('%s is refused', (name) => {
    const result = resolveSecretWriteInput({ name, value: 'x' }, false);
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(JSON.stringify(result)).toContain('Microsoft Teams connection');
  });

  test('a look-alike name that is not in the reserved namespace is accepted', () => {
    expect(resolveSecretWriteInput({ name: 'TEAMS_WEBHOOK_URL', value: 'x' }, false)).toMatchObject({ ok: true });
    expect(resolveSecretWriteInput({ name: 'MY_MS_TEAMS_NOTE', value: 'x' }, false)).toMatchObject({ ok: true });
  });
});
