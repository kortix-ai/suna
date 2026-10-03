import { describe, expect, test } from 'bun:test';

import { AppAccessDeniedError, appStatus, openApp } from './apps';

describe('appStatus', () => {
  test('a running deployment is live', () => {
    const status = appStatus({ active_deployment_id: 'dep-1', desired_state: 'running' });
    expect(status).toEqual({ live: true, label: 'Running' });
  });

  test('a stopped deployment is suspended, not live', () => {
    const status = appStatus({ active_deployment_id: 'dep-1', desired_state: 'stopped' });
    expect(status).toEqual({ live: false, label: 'Suspended' });
  });

  test('no active deployment is not deployed', () => {
    const status = appStatus({ active_deployment_id: null, desired_state: 'running' });
    expect(status).toEqual({ live: false, label: 'Not deployed' });
  });
});

describe('openApp', () => {
  test('mints the access session and opens its url', async () => {
    const calls: string[] = [];
    await openApp(
      { viewer_can_access: true },
      {
        createSession: async () => {
          calls.push('session');
          return { url: 'https://seed.apps.kortix.com/s/abc' };
        },
        openLink: async (url) => {
          calls.push(`open:${url}`);
        },
      },
    );
    expect(calls).toEqual(['session', 'open:https://seed.apps.kortix.com/s/abc']);
  });

  test('an app the viewer cannot open throws before any request', async () => {
    let sessions = 0;
    let opened = 0;
    const run = openApp(
      { viewer_can_access: false },
      {
        createSession: async () => {
          sessions += 1;
          return { url: 'https://seed.apps.kortix.com/s/abc' };
        },
        openLink: async () => {
          opened += 1;
        },
      },
    );
    await expect(run).rejects.toBeInstanceOf(AppAccessDeniedError);
    expect(sessions).toBe(0);
    expect(opened).toBe(0);
  });

  test('an app with an unknown access state still opens (undefined is not denied)', async () => {
    let sessions = 0;
    await openApp(
      {},
      {
        createSession: async () => {
          sessions += 1;
          return { url: 'https://seed.apps.kortix.com/s/abc' };
        },
        openLink: async () => {},
      },
    );
    expect(sessions).toBe(1);
  });

  test('a failed access session propagates and never opens a browser', async () => {
    let opened = 0;
    const run = openApp(
      { viewer_can_access: true },
      {
        createSession: async () => {
          throw new Error('Failed to create App access session');
        },
        openLink: async () => {
          opened += 1;
        },
      },
    );
    await expect(run).rejects.toThrow('Failed to create App access session');
    expect(opened).toBe(0);
  });
});
