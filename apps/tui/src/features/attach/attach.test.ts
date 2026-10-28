import { describe, expect, test } from 'bun:test';
import { ATTACH_UNSUPPORTED } from '@kortix/cli/src/attach-opencode.ts';

import type { ResolvedHost } from '../../auth/hosts.ts';
import { attachRefusal, authFromHost } from './attach.ts';

const HOST: ResolvedHost = {
  name: 'local',
  backendUrl: 'http://localhost:17408/v1',
  token: 'test-token',
  accountId: 'acc-1',
  userEmail: 'dev@kortix.test',
  source: 'config',
};

describe('authFromHost', () => {
  test('hands the CLI the origin, not the /v1 mount', () => {
    expect(authFromHost(HOST)).toMatchObject({
      api_base: 'http://localhost:17408',
      token: 'test-token',
      account_id: 'acc-1',
      user_email: 'dev@kortix.test',
    });
  });
});

describe('attachRefusal', () => {
  const PI = ['file.import', 'session.subagents'];

  test('the open session on a runtime without session.attach is refused with a toast', () => {
    const refusal = attachRefusal('ses_1', 'ses_1', PI);
    expect(refusal).toContain(ATTACH_UNSUPPORTED);
    expect(refusal).toContain('Alt+t');
  });

  test('capabilities not read yet, an OpenCode runtime, or another session attach', () => {
    expect(attachRefusal('ses_1', 'ses_1', null)).toBeNull();
    expect(attachRefusal('ses_1', 'ses_1', ['session.subagents', 'session.attach'])).toBeNull();
    // Only the open session was read; attach refuses any other by its own read.
    expect(attachRefusal('ses_2', 'ses_1', PI)).toBeNull();
  });
});
