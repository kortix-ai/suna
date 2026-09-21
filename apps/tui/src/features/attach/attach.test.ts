import { describe, expect, test } from 'bun:test';
import { AttachOpenCodeError } from '@kortix/cli/src/attach-opencode.ts';

import type { ResolvedHost } from '../../auth/hosts.ts';
import { attachResultToast, attachStatusLine } from './attach-status.tsx';
import {
  type AttachSignals,
  type AttachStatus,
  FORWARDED_SIGNALS,
  authFromHost,
  runAttach,
} from './attach.ts';

const HOST: ResolvedHost = {
  name: 'local',
  backendUrl: 'http://localhost:17408/v1',
  token: 'test-token',
  accountId: 'acc-1',
  userEmail: 'dev@kortix.test',
  source: 'config',
};

/** Records the suspend/resume order so a missing resume is a failing test. */
function fakeRenderer() {
  const calls: string[] = [];
  return {
    calls,
    control: {
      suspend: () => {
        calls.push('suspend');
      },
      resume: () => {
        calls.push('resume');
      },
    },
  };
}

function fakeSignals() {
  const bound: NodeJS.Signals[] = [];
  const released: NodeJS.Signals[] = [];
  const signals: AttachSignals = {
    on: (signal) => {
      bound.push(signal);
    },
    off: (signal) => {
      released.push(signal);
    },
  };
  return { bound, released, signals };
}

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

describe('runAttach', () => {
  test('suspends, runs, and resumes on success', async () => {
    const renderer = fakeRenderer();
    const signals = fakeSignals();
    const lines: string[] = [];
    const statuses: AttachStatus[] = [];

    const result = await runAttach({
      renderer: renderer.control,
      host: HOST,
      projectId: 'p1',
      sessionId: 's1',
      onStatus: (status) => statuses.push(status),
      deps: {
        write: (text) => lines.push(text),
        signals: signals.signals,
        attach: async (options) => {
          // The renderer must already be down before opencode paints.
          expect(renderer.calls).toEqual(['suspend']);
          options.onStatus?.('resolving', 'Resolving session s1…', {});
          options.onStatus?.('attached', 'Connecting to s1', {});
          return { exitCode: 0, opencodeSessionId: 'ses_1', proxyUrl: 'http://127.0.0.1:1234' };
        },
      },
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(renderer.calls).toEqual(['suspend', 'resume']);
    expect(statuses.map((status) => status.stage)).toEqual(['resolving', 'attached']);
    expect(lines.join('')).toContain('Resolving session s1…');
    expect(signals.bound).toEqual([...FORWARDED_SIGNALS]);
    expect(signals.released).toEqual([...FORWARDED_SIGNALS]);
  });

  test('resumes on an AttachOpenCodeError and reports its stage', async () => {
    const renderer = fakeRenderer();
    const signals = fakeSignals();
    const lines: string[] = [];

    const result = await runAttach({
      renderer: renderer.control,
      host: HOST,
      projectId: 'p1',
      sessionId: 's1',
      deps: {
        write: (text) => lines.push(text),
        signals: signals.signals,
        attach: async () => {
          throw new AttachOpenCodeError('downloading-binary', 'network is unreachable');
        },
      },
    });

    expect(result).toEqual({
      error: { stage: 'downloading-binary', message: 'network is unreachable' },
    });
    // The whole point: a failed attach still repaints the TUI.
    expect(renderer.calls).toEqual(['suspend', 'resume']);
    expect(signals.released).toEqual([...FORWARDED_SIGNALS]);
    expect(lines.join('')).toContain('attach failed at downloading-binary');
  });

  test('resumes on a plain throw too', async () => {
    const renderer = fakeRenderer();
    const result = await runAttach({
      renderer: renderer.control,
      host: HOST,
      projectId: 'p1',
      sessionId: 's1',
      deps: {
        write: () => {},
        signals: fakeSignals().signals,
        attach: async () => {
          throw new Error('spawn EACCES');
        },
      },
    });
    expect(result).toEqual({ error: { stage: 'attached', message: 'spawn EACCES' } });
    expect(renderer.calls).toEqual(['suspend', 'resume']);
  });

  test('forwards SIGINT, SIGTERM and SIGWINCH to the child', async () => {
    const renderer = fakeRenderer();
    const handlers = new Map<NodeJS.Signals, () => void>();
    const killed: NodeJS.Signals[] = [];

    await runAttach({
      renderer: renderer.control,
      host: HOST,
      projectId: 'p1',
      sessionId: 's1',
      deps: {
        write: () => {},
        signals: {
          on: (signal, handler) => handlers.set(signal, handler),
          off: (signal) => handlers.delete(signal),
        },
        attach: async (options) => {
          const child = {
            killed: false,
            kill: (signal?: NodeJS.Signals | number) => {
              killed.push(signal as NodeJS.Signals);
              return true;
            },
          };
          options.onChild?.(child as never);
          for (const signal of FORWARDED_SIGNALS) handlers.get(signal)?.();
          return { exitCode: 130, opencodeSessionId: 'ses_1', proxyUrl: 'http://127.0.0.1:1' };
        },
      },
    });

    expect(killed).toEqual([...FORWARDED_SIGNALS]);
    // Handlers are released, so the TUI owns its own signals again.
    expect(handlers.size).toBe(0);
  });
});

describe('attach status rendering', () => {
  test('names the stage in the banner line', () => {
    expect(
      attachStatusLine({ stage: 'restarting', detail: 'Session is stopped — starting…' }),
    ).toBe('Starting the sandbox — Session is stopped — starting…');
  });

  test('turns a result into the toast the app shows', () => {
    expect(attachResultToast({ exitCode: 0 })).toEqual({
      message: 'opencode exited.',
      kind: 'info',
    });
    expect(attachResultToast({ exitCode: 2 })).toEqual({
      message: 'opencode exited with code 2.',
      kind: 'error',
    });
    expect(attachResultToast({ error: { stage: 'proxy-ready', message: 'EADDRINUSE' } })).toEqual({
      message: 'Attach failed at proxy-ready: EADDRINUSE',
      kind: 'error',
    });
  });
});
