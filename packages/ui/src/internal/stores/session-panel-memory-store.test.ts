import { beforeEach, describe, expect, test } from 'bun:test';
import {
  MAX_REMEMBERED_PANELS,
  panelToRestore,
  rememberedPanelOf,
  useSessionPanelMemoryStore,
} from './session-panel-memory-store';

describe('rememberedPanelOf — what the Easy panel is showing, as something it can open again', () => {
  test('the terminal', () => {
    expect(rememberedPanelOf({ terminalOpen: true, detailKey: null })).toEqual({
      kind: 'view',
      view: 'terminal',
    });
  });

  test('the files explorer, on All files or on the Changes diff', () => {
    expect(rememberedPanelOf({ terminalOpen: false, detailKey: 'files' })).toEqual({
      kind: 'view',
      view: 'files',
    });
    expect(rememberedPanelOf({ terminalOpen: false, detailKey: 'files:changes' })).toEqual({
      kind: 'view',
      view: 'files',
      target: { changes: true },
    });
  });

  test('the browser, on its landing or on the page it was showing', () => {
    expect(rememberedPanelOf({ terminalOpen: false, detailKey: 'app:landing' })).toEqual({
      kind: 'view',
      view: 'browser',
    });
    expect(
      rememberedPanelOf({ terminalOpen: false, detailKey: 'app:http://localhost:3000/docs?a=1' }),
    ).toEqual({
      kind: 'view',
      view: 'browser',
      target: { url: 'http://localhost:3000/docs?a=1' },
    });
  });

  test('the audit trail', () => {
    expect(rememberedPanelOf({ terminalOpen: false, detailKey: 'audit' })).toEqual({
      kind: 'view',
      view: 'audit',
    });
  });

  test('a file preview, by its path', () => {
    expect(
      rememberedPanelOf({ terminalOpen: false, detailKey: 'file:/workspace/report.md' }),
    ).toEqual({
      kind: 'file',
      path: '/workspace/report.md',
    });
  });

  test('a tool step, or nothing at all, is not remembered', () => {
    expect(rememberedPanelOf({ terminalOpen: false, detailKey: 'step:3:call_1' })).toBeNull();
    expect(rememberedPanelOf({ terminalOpen: false, detailKey: null })).toBeNull();
  });
});

describe('panelToRestore — reopen only on a running session, with the panel closed, on desktop', () => {
  const remembered = { kind: 'view', view: 'terminal' } as const;
  const base = { remembered, status: 'running', panelOpen: false, isMobile: false } as const;

  test('a running session gets its panel back', () => {
    expect(panelToRestore(base)).toEqual(remembered);
  });

  test('a session that is not running stays closed: a restore must not wake its computer', () => {
    for (const status of [
      'stopped',
      'provisioning',
      'failed',
      'completed',
      'queued',
      undefined,
    ] as const) {
      expect(panelToRestore({ ...base, status })).toBeNull();
    }
  });

  test('nothing remembered, a panel already open, or a phone: nothing to do', () => {
    expect(panelToRestore({ ...base, remembered: undefined })).toBeNull();
    expect(panelToRestore({ ...base, panelOpen: true })).toBeNull();
    expect(panelToRestore({ ...base, isMobile: true })).toBeNull();
  });
});

describe('useSessionPanelMemoryStore', () => {
  beforeEach(() => {
    useSessionPanelMemoryStore.setState({ bySession: {} });
  });

  test('remembers per session, and null forgets', () => {
    const { remember } = useSessionPanelMemoryStore.getState();
    remember('a', { kind: 'view', view: 'terminal' });
    remember('b', { kind: 'file', path: '/workspace/x.md' });
    expect(useSessionPanelMemoryStore.getState().bySession).toEqual({
      a: { kind: 'view', view: 'terminal' },
      b: { kind: 'file', path: '/workspace/x.md' },
    });
    remember('a', null);
    expect(useSessionPanelMemoryStore.getState().bySession).toEqual({
      b: { kind: 'file', path: '/workspace/x.md' },
    });
  });

  test('an unchanged panel writes nothing', () => {
    const { remember } = useSessionPanelMemoryStore.getState();
    remember('a', { kind: 'view', view: 'terminal' });
    const before = useSessionPanelMemoryStore.getState().bySession;
    remember('a', { kind: 'view', view: 'terminal' });
    remember('z', null);
    expect(useSessionPanelMemoryStore.getState().bySession).toBe(before);
  });

  test(`keeps the ${MAX_REMEMBERED_PANELS} most recently remembered sessions`, () => {
    const { remember } = useSessionPanelMemoryStore.getState();
    for (let i = 0; i <= MAX_REMEMBERED_PANELS; i++)
      remember(`s${i}`, { kind: 'view', view: 'terminal' });
    const keys = () => Object.keys(useSessionPanelMemoryStore.getState().bySession);
    expect(keys()).toHaveLength(MAX_REMEMBERED_PANELS);
    expect(keys()).not.toContain('s0'); // the oldest went first
    remember('s1', { kind: 'view', view: 'files' }); // touched again: now the newest
    remember('next', { kind: 'view', view: 'terminal' });
    expect(keys()).toHaveLength(MAX_REMEMBERED_PANELS);
    expect(keys()).not.toContain('s2'); // the oldest is now s2, not the re-touched s1
    expect(keys().slice(-2)).toEqual(['s1', 'next']);
  });
});
