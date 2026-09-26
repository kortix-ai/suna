import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import { testRender } from '@opentui/react/test-utils';

import type { Host } from '@kortix/cli/src/api/config.ts';

import type { HostEntry, ResolvedHost } from '../../auth/hosts.ts';
import { DEFAULT_API_URL, HostForm, maskToken } from './host-form.tsx';
import { type LoginFlowDeps, hostRow } from './index.ts';
import { LoginScreen } from './login-screen.tsx';

// React 19 needs this before `act`. Without `act` a key press updates state but
// the next frame is captured before React commits. See docs/opentui-notes.md.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN = 'kortix_pat_abcdefghijklmnopqrstuvwxyz';

const HOSTS: HostEntry[] = [
  {
    name: 'cloud',
    backendUrl: 'https://api.kortix.com/v1',
    hasToken: false,
    active: false,
    userEmail: '',
  },
  {
    name: 'local-dev',
    backendUrl: 'http://localhost:17408/v1',
    hasToken: true,
    active: true,
    userEmail: 'agent-g@kortix.test',
  },
];

const STORED: Host = {
  url: 'http://localhost:17408',
  token: TOKEN,
  user_id: 'user-1',
  user_email: 'agent-g@kortix.test',
  account_id: 'acc-1',
  logged_in_at: '2026-09-17T12:00:00.000Z',
};

function deps(overrides: Partial<LoginFlowDeps> = {}): Partial<LoginFlowDeps> {
  return {
    read: (name) => (name === 'local-dev' ? STORED : null),
    save: () => {},
    remove: () => ({ removed: true }),
    now: () => new Date('2026-09-17T12:00:00.000Z'),
    validate: async () => ({ valid: false, error: undefined }),
    ...overrides,
  };
}

describe('maskToken', () => {
  test('shows bullets and a length, never a character of the token', () => {
    const masked = maskToken(TOKEN, 40);
    expect(masked).not.toContain('kortix_pat_');
    expect(masked).toContain(`${TOKEN.length} chars`);
    expect(masked.replace(/[^•]/g, '').length).toBeGreaterThan(0);
  });

  test('clamps the bullets so a 779-character JWT does not wrap the form', () => {
    const jwt = 'x'.repeat(779);
    expect(maskToken(jwt, 30).length).toBeLessThanOrEqual(30);
    expect(maskToken(jwt, 30)).toContain('779 chars');
  });

  test('an empty token renders nothing', () => {
    expect(maskToken('', 40)).toBe('');
  });
});

describe('hostRow', () => {
  test('marks a host with no token', () => {
    expect(hostRow(HOSTS[0] as HostEntry, 60)).toContain('no token');
    expect(hostRow(HOSTS[0] as HostEntry, 60)).toContain('https://api.kortix.com');
  });

  test('shows the signed-in identity', () => {
    expect(hostRow(HOSTS[1] as HostEntry, 60)).toContain('agent-g@kortix.test');
  });
});

describe('<LoginScreen/> — the host list', () => {
  test('renders every configured host with its URL and identity', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      <LoginScreen
        hosts={HOSTS}
        width={72}
        height={14}
        onLoggedIn={() => {}}
        onQuit={() => {}}
        deps={deps()}
      />,
      { width: 72, height: 14 },
    );
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('Kortix — pick a host');
    expect(frame).toContain('cloud');
    expect(frame).toContain('https://api.kortix.com');
    expect(frame).toContain('no token');
    expect(frame).toContain('local-dev');
    expect(frame).toContain('agent-g@kortix.test');
    expect(frame).toContain('Enter use · n add');
    renderer.destroy();
  });

  test('Enter on a host with a token resolves it and hands it to onLoggedIn', async () => {
    const loggedIn: ResolvedHost[] = [];
    const { flush, mockInput, renderer } = await testRender(
      <LoginScreen
        hosts={HOSTS}
        width={72}
        height={14}
        onLoggedIn={(resolved) => loggedIn.push(resolved)}
        onQuit={() => {}}
        deps={deps()}
      />,
      { width: 72, height: 14 },
    );
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(loggedIn).toHaveLength(1);
    expect(loggedIn[0]?.name).toBe('local-dev');
    expect(loggedIn[0]?.backendUrl).toBe('http://localhost:17408/v1');
    expect(loggedIn[0]?.accountId).toBe('acc-1');
    renderer.destroy();
  });

  test('Enter on a host with no token opens the token form instead of erroring', async () => {
    const loggedIn: ResolvedHost[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <LoginScreen
        hosts={HOSTS}
        width={72}
        height={14}
        onLoggedIn={(resolved) => loggedIn.push(resolved)}
        onQuit={() => {}}
        deps={deps()}
      />,
      { width: 72, height: 14 },
    );
    await flush();
    await act(async () => mockInput.pressKey('k'));
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(loggedIn).toHaveLength(0);
    expect(captureCharFrame()).toContain('Replace the token for cloud');
    renderer.destroy();
  });

  test('d asks before removing, and y removes through the injected store', async () => {
    const removed: string[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <LoginScreen
        hosts={HOSTS}
        width={72}
        height={16}
        onLoggedIn={() => {}}
        onQuit={() => {}}
        deps={deps({
          remove: (name) => {
            removed.push(name);
            return { removed: true };
          },
        })}
      />,
      { width: 72, height: 16 },
    );
    await flush();
    await act(async () => mockInput.pressKey('d'));
    await flush();
    expect(captureCharFrame()).toContain('Remove host local-dev?');
    expect(removed).toEqual([]);
    await act(async () => mockInput.pressKey('y'));
    await flush();
    expect(removed).toEqual(['local-dev']);
    renderer.destroy();
  });

  test('Esc on the list quits', async () => {
    let quits = 0;
    const { flush, mockInput, renderer } = await testRender(
      <LoginScreen
        hosts={HOSTS}
        width={72}
        height={14}
        onLoggedIn={() => {}}
        onQuit={() => {
          quits += 1;
        }}
        deps={deps()}
      />,
      { width: 72, height: 14 },
    );
    await flush();
    await act(async () => mockInput.pressEscape());
    // A lone Escape is held by the parser until a timeout proves nothing
    // follows it, so the assertion waits for that timeout.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await flush();
    expect(quits).toBe(1);
    renderer.destroy();
  });
});

describe('<LoginScreen/> — the add-host form', () => {
  test('n opens the form with the cloud API URL prefilled', async () => {
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <LoginScreen
        hosts={HOSTS}
        width={72}
        height={14}
        onLoggedIn={() => {}}
        onQuit={() => {}}
        deps={deps()}
      />,
      { width: 72, height: 14 },
    );
    await flush();
    await act(async () => mockInput.pressKey('n'));
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('Add a host');
    expect(frame).toContain('Name');
    expect(frame).toContain('API URL');
    expect(frame).toContain('https://api.kortix.com');
    expect(frame).toContain('Token');
    expect(frame).toContain('Tab next field');
    renderer.destroy();
  });

  test('an empty host list opens straight into the form', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      <LoginScreen
        hosts={[]}
        width={72}
        height={14}
        onLoggedIn={() => {}}
        onQuit={() => {}}
        deps={deps()}
      />,
      { width: 72, height: 14 },
    );
    await flush();
    expect(captureCharFrame()).toContain('Add a host');
    renderer.destroy();
  });

  test('typing into the token field renders bullets and a count, never the token', async () => {
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <LoginScreen
        hosts={HOSTS}
        width={72}
        height={14}
        onLoggedIn={() => {}}
        onQuit={() => {}}
        deps={deps()}
      />,
      { width: 72, height: 14 },
    );
    await flush();
    await act(async () => mockInput.pressKey('n'));
    await flush();
    // Tab twice: Name → API URL → Token. Only then is no `<input>` focused,
    // so the screen's own handler owns the printable keys.
    await act(async () => mockInput.pressTab());
    await flush();
    await act(async () => mockInput.pressTab());
    await flush();
    await act(async () => mockInput.typeText('sekret42'));
    await flush();

    const frame = captureCharFrame();
    expect(frame).not.toContain('sekret42');
    expect(frame).not.toContain('sekret');
    expect(frame).toContain('••••••••');
    expect(frame).toContain('8 chars');
    renderer.destroy();
  });

  test('submitting an unparseable URL shows the inline error and never calls validate', async () => {
    let validateCalls = 0;
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <LoginScreen
        hosts={HOSTS}
        width={72}
        height={16}
        onLoggedIn={() => {}}
        onQuit={() => {}}
        deps={deps({
          validate: async () => {
            validateCalls += 1;
            return { valid: true, identity: { user_id: 'u', email: 'e', accounts: [] } };
          },
        })}
      />,
      { width: 72, height: 16 },
    );
    await flush();
    await act(async () => mockInput.pressKey('n'));
    await flush();
    await act(async () => mockInput.typeText('scratch'));
    await flush();
    await act(async () => mockInput.pressTab());
    await flush();
    // Clear the prefilled `https://api.kortix.com`, then type a scheme the
    // login flow refuses.
    for (let step = 0; step < 30; step += 1) {
      await act(async () => mockInput.pressBackspace());
    }
    await flush();
    await act(async () => mockInput.typeText('ftp://nope'));
    await flush();
    await act(async () => mockInput.pressTab());
    await flush();
    await act(async () => mockInput.typeText('tok'));
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();

    expect(captureCharFrame()).toContain('Not a URL: ftp://nope');
    expect(validateCalls).toBe(0);
    renderer.destroy();
  });

  test('a rejected token renders the API status inline and stays on the form', async () => {
    const loggedIn: ResolvedHost[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <LoginScreen
        hosts={HOSTS}
        width={72}
        height={16}
        onLoggedIn={(resolved) => loggedIn.push(resolved)}
        onQuit={() => {}}
        deps={deps({
          validate: async () => ({
            valid: false,
            error: Object.assign(new Error('Invalid API key'), { status: 401, name: 'ApiError' }),
          }),
        })}
      />,
      { width: 72, height: 16 },
    );
    await flush();
    await act(async () => mockInput.pressKey('n'));
    await flush();
    await act(async () => mockInput.typeText('scratch'));
    await flush();
    await act(async () => mockInput.pressTab());
    await act(async () => mockInput.pressTab());
    await flush();
    await act(async () => mockInput.typeText('badtoken'));
    await flush();
    await act(async () => mockInput.pressEnter());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await flush();

    expect(captureCharFrame()).toContain('Token rejected (401): Invalid API key');
    expect(loggedIn).toHaveLength(0);
    renderer.destroy();
  });

  test('a valid token saves the host and hands the resolved host back', async () => {
    const loggedIn: ResolvedHost[] = [];
    const saved: Array<{ name: string; host: Host; makeActive: boolean }> = [];
    const { flush, mockInput, renderer } = await testRender(
      <LoginScreen
        hosts={HOSTS}
        width={72}
        height={16}
        onLoggedIn={(resolved) => loggedIn.push(resolved)}
        onQuit={() => {}}
        deps={deps({
          save: (name, host, makeActive) => saved.push({ name, host, makeActive }),
          validate: async () => ({
            valid: true,
            identity: {
              user_id: 'user-9',
              email: 'new@kortix.test',
              accounts: [{ account_id: 'acc-9', slug: 'a9', name: 'Nine', role: 'owner' }],
            },
          }),
        })}
      />,
      { width: 72, height: 16 },
    );
    await flush();
    await act(async () => mockInput.pressKey('n'));
    await flush();
    await act(async () => mockInput.typeText('scratch'));
    await flush();
    await act(async () => mockInput.pressTab());
    await act(async () => mockInput.pressTab());
    await flush();
    await act(async () => mockInput.typeText('goodtoken'));
    await flush();
    await act(async () => mockInput.pressEnter());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await flush();

    expect(saved).toHaveLength(1);
    expect(saved[0]?.name).toBe('scratch');
    expect(saved[0]?.makeActive).toBe(true);
    expect(saved[0]?.host.user_email).toBe('new@kortix.test');
    expect(saved[0]?.host.account_id).toBe('acc-9');
    expect(saved[0]?.host.token).toBe('goodtoken');
    expect(loggedIn).toHaveLength(1);
    expect(loggedIn[0]?.name).toBe('scratch');
    renderer.destroy();
  });
});

describe('<HostForm/>', () => {
  test('edit-token mode locks the name and the URL and starts on the token', async () => {
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <HostForm
        mode="edit-token"
        initialName="local-dev"
        initialUrl="http://localhost:17408"
        width={60}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
      { width: 62, height: 10 },
    );
    await flush();
    expect(captureCharFrame()).toContain('Replace the token for local-dev');
    // No `<input>` is mounted, so the first printable key is already token input.
    await act(async () => mockInput.typeText('abc'));
    await flush();
    const frame = captureCharFrame();
    expect(frame).not.toContain('abc');
    expect(frame).toContain('3 chars');
    renderer.destroy();
  });

  test('an add form starts with an EMPTY url and submits the default for it', async () => {
    const submitted: Array<{ name: string; url: string; token: string }> = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <HostForm
        mode="add"
        width={60}
        onSubmit={(values) => submitted.push(values)}
        onCancel={() => {}}
      />,
      { width: 62, height: 12 },
    );
    await flush();
    // The default is the PLACEHOLDER, never the value. Pre-filling it looked
    // identical and appended to whatever the user typed, because an `<input>`
    // cursor starts at the end of its value — measured in a real pty run as
    // `https://api.kortix.comhttp://localhost:17408`.
    await act(async () => mockInput.typeText('scratch'));
    await flush();
    await act(async () => mockInput.pressTab());
    await flush();
    await act(async () => mockInput.typeText('http://localhost:17408'));
    await flush();
    expect(captureCharFrame()).not.toContain('api.kortix.comhttp');
    await act(async () => mockInput.pressTab());
    await flush();
    await act(async () => mockInput.typeText('tok123'));
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(submitted).toEqual([
      { name: 'scratch', url: 'http://localhost:17408', token: 'tok123' },
    ]);
    renderer.destroy();
  });

  test('an empty url field submits DEFAULT_API_URL', async () => {
    const submitted: Array<{ name: string; url: string; token: string }> = [];
    const { flush, mockInput, renderer } = await testRender(
      <HostForm
        mode="add"
        width={60}
        onSubmit={(values) => submitted.push(values)}
        onCancel={() => {}}
      />,
      { width: 62, height: 12 },
    );
    await flush();
    await act(async () => mockInput.typeText('cloud'));
    await flush();
    await act(async () => mockInput.pressTab());
    await flush();
    await act(async () => mockInput.pressTab());
    await flush();
    await act(async () => mockInput.typeText('tok123'));
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(submitted).toEqual([{ name: 'cloud', url: DEFAULT_API_URL, token: 'tok123' }]);
    renderer.destroy();
  });

  test('Enter submits the collected values', async () => {
    const submitted: Array<{ name: string; url: string; token: string }> = [];
    const { flush, mockInput, renderer } = await testRender(
      <HostForm
        mode="edit-token"
        initialName="local-dev"
        initialUrl="http://localhost:17408"
        width={60}
        onSubmit={(values) => submitted.push(values)}
        onCancel={() => {}}
      />,
      { width: 62, height: 10 },
    );
    await flush();
    await act(async () => mockInput.typeText('tok123'));
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(submitted).toEqual([
      { name: 'local-dev', url: 'http://localhost:17408', token: 'tok123' },
    ]);
    renderer.destroy();
  });

  test('a bracketed paste fills the token field — the way a PAT actually arrives', async () => {
    const jwt = `eyJ.${'p'.repeat(700)}.${'s'.repeat(60)}`;
    const submitted: Array<{ token: string }> = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <HostForm
        mode="edit-token"
        initialName="local-dev"
        initialUrl="http://localhost:17408"
        width={60}
        onSubmit={(values) => submitted.push({ token: values.token })}
        onCancel={() => {}}
      />,
      { width: 62, height: 10 },
    );
    await flush();
    await act(async () => {
      await mockInput.pasteBracketedText(jwt);
    });
    await flush();

    const frame = captureCharFrame();
    expect(frame).not.toContain('eyJ');
    expect(frame).toContain(`${jwt.length} chars`);
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(submitted).toEqual([{ token: jwt }]);
    renderer.destroy();
  });

  test('backspace deletes one character of the token', async () => {
    const submitted: Array<{ token: string }> = [];
    const { flush, mockInput, renderer } = await testRender(
      <HostForm
        mode="edit-token"
        initialName="x"
        initialUrl="http://localhost:1"
        width={60}
        onSubmit={(values) => submitted.push({ token: values.token })}
        onCancel={() => {}}
      />,
      { width: 62, height: 10 },
    );
    await flush();
    await act(async () => mockInput.typeText('abcd'));
    await flush();
    await act(async () => mockInput.pressBackspace());
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(submitted).toEqual([{ token: 'abc' }]);
    renderer.destroy();
  });
});
