import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';

import type { TestRendererSetup } from '@opentui/core/testing';
import { testRender } from '@opentui/react/test-utils';

import { initKortix, resetKortixForTest } from '../../../kortix.ts';
import type { CommandContext } from '../../../commands/registry.ts';
import { Composer, type SessionState, exportFileName } from './composer.tsx';

// React 19 needs this before `act`. See docs/opentui-notes.md.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The composer mounts two real SDK hooks of its own — `useSessionPrompts` (the
 * durable inbox) and `useModelDefaults` (the server-resolved default model).
 * Rather than mock the module (a `mock.module` on `@kortix/sdk/react` leaks
 * into every other test file in the run — see the repo's bun-test learnings),
 * the client points at a dead port with retries off. Both queries fail fast and
 * land on their documented empty states: no queued prompts, no resolved
 * default. Everything the assertions below touch is a prop.
 */
beforeAll(() => {
  resetKortixForTest();
  initKortix({
    name: 'test',
    backendUrl: 'http://127.0.0.1:9/v1',
    token: 'test-token',
    accountId: '',
    userEmail: '',
    source: 'env',
  });
});

const MODELS = [
  {
    providerID: 'kortix',
    providerName: 'Kortix',
    modelID: 'anthropic/claude-sonnet-5',
    modelName: 'Claude Sonnet 5',
    provider: 'anthropic',
    enabled: true,
    variants: { low: {}, high: {} },
  },
  {
    providerID: 'kortix',
    providerName: 'Kortix',
    modelID: 'openai/gpt-5.6-sol',
    modelName: 'GPT-5.6 Sol',
    provider: 'openai',
    enabled: true,
  },
  {
    providerID: 'kortix',
    providerName: 'Kortix',
    modelID: 'openai/o9-preview',
    modelName: 'O9 Preview',
    provider: 'openai',
    enabled: false,
  },
] as SessionState['models'];

interface Spies {
  send: ReturnType<typeof mock>;
  cancel: ReturnType<typeof mock>;
  runCommand: ReturnType<typeof mock>;
  setModel: ReturnType<typeof mock>;
  setAgent: ReturnType<typeof mock>;
  setVariant: ReturnType<typeof mock>;
  onCommand: ReturnType<typeof mock>;
}

function fakeSession(spies: Spies, overrides: Partial<SessionState> = {}): SessionState {
  return {
    models: MODELS,
    agents: [
      { name: 'galileo', description: 'Generalist', mode: 'primary' },
      { name: 'reviewer', description: 'Reviews diffs', mode: 'primary' },
    ],
    defaultAgent: 'galileo',
    agentName: null,
    commands: [
      { name: 'deploy', path: '.kortix/commands/deploy.md', description: 'Ship the build' },
    ],
    picks: {
      model: null,
      agent: null,
      variant: null,
      setModel: spies.setModel,
      setAgent: spies.setAgent,
      setVariant: spies.setVariant,
    },
    isBusy: false,
    isSending: false,
    sendError: null,
    send: spies.send,
    cancel: spies.cancel,
    runCommand: spies.runCommand,
    ...overrides,
  } as unknown as SessionState;
}

function newSpies(): Spies {
  return {
    send: mock(() => {}),
    cancel: mock(() => Promise.resolve({ status: 'skipped' })),
    runCommand: mock(() => Promise.resolve()),
    setModel: mock(() => {}),
    setAgent: mock(() => {}),
    setVariant: mock(() => {}),
    onCommand: mock(() => {}),
  };
}

let active: TestRendererSetup | null = null;

const CONTEXT: CommandContext = {
  hasProject: true,
  hasSession: true,
  hasAccount: true,
  capabilities: null,
};

async function mountComposer(
  session: SessionState,
  spies: Spies,
  onToast?: (message: string) => void,
): Promise<TestRendererSetup> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 } },
  });
  const setup = await testRender(
    <QueryClientProvider client={queryClient}>
      <Composer
        session={session}
        projectId="project-1"
        sessionId="session-1"
        focused
        width={60}
        context={CONTEXT}
        onCommand={spies.onCommand}
        onToast={onToast}
      />
    </QueryClientProvider>,
    { width: 60, height: 30 },
  );
  active = setup;
  await setup.renderOnce();
  return setup;
}

afterEach(() => {
  active?.renderer.destroy();
  active = null;
});

function frame(setup: TestRendererSetup): string {
  return setup.captureCharFrame();
}

/**
 * Press Escape and let it land.
 *
 * A lone `ESC` byte is ambiguous with the start of an escape SEQUENCE, so the
 * parser holds it for a disambiguation window before it emits `name: "escape"`.
 * Asserting on the next frame without waiting reads the frame from BEFORE the
 * key was ever delivered — which is what made three of these tests look like a
 * broken keymap. Verified with `scripts/` probes: the same press with no wait
 * produces no key event at all.
 */
async function pressEscape(setup: TestRendererSetup): Promise<void> {
  await act(async () => {
    setup.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 120));
  });
  await setup.renderOnce();
}

describe('composer typing and sending', () => {
  test('the placeholder shows until the user types, then the text appears', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies), spies);
    expect(frame(setup)).toContain('Type a prompt · / for commands');

    await act(async () => {
      await setup.mockInput.typeText('ship it', 1);
    });
    await setup.renderOnce();
    expect(frame(setup)).toContain('ship it');
  });

  test('Enter sends the text through session.send and clears the box', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies), spies);

    await act(async () => {
      await setup.mockInput.typeText('hello world', 1);
    });
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await setup.renderOnce();

    expect(spies.send).toHaveBeenCalledTimes(1);
    expect(spies.send.mock.calls[0]?.[0]).toBe('hello world');
    // Cleared: the placeholder is back and the text is gone.
    expect(frame(setup)).toContain('Type a prompt · / for commands');
    expect(frame(setup)).not.toContain('hello world');
  });

  test('Enter on an empty draft sends nothing', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies), spies);
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    expect(spies.send).not.toHaveBeenCalled();
  });

  test('Alt+Enter inserts a newline instead of sending, and the box grows', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies), spies);
    await act(async () => {
      await setup.mockInput.typeText('first', 1);
    });
    await act(async () => {
      setup.mockInput.pressEnter({ meta: true });
    });
    await act(async () => {
      await setup.mockInput.typeText('second', 1);
    });
    await setup.renderOnce();

    expect(spies.send).not.toHaveBeenCalled();
    const text = frame(setup);
    expect(text).toContain('first');
    expect(text).toContain('second');
    // Two separate rows, so the second word is not on the first word's line.
    const lines = text.split('\n');
    expect(lines.some((line) => line.includes('first') && !line.includes('second'))).toBe(true);
  });

  test('the tray states the model and the agent', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies), spies);
    const text = frame(setup);
    expect(text).toContain('galileo');
  });

  test('a send error renders one line under the composer', async () => {
    const spies = newSpies();
    const session = fakeSession(spies, {
      sendError: { kind: 'billing', message: 'Out of credits' },
    } as Partial<SessionState>);
    const setup = await mountComposer(session, spies);
    expect(frame(setup)).toContain('billing: Out of credits');
  });

  test('a busy session says the next prompt queues', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies, { isBusy: true }), spies);
    expect(frame(setup)).toContain('Type to queue the next prompt');
  });
});

describe('escape', () => {
  test('Esc clears a non-empty draft', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies), spies);
    await act(async () => {
      await setup.mockInput.typeText('scrap this', 1);
    });
    await pressEscape(setup);
    expect(frame(setup)).not.toContain('scrap this');
    expect(spies.cancel).not.toHaveBeenCalled();
  });

  test('Esc ×3 on an empty busy input stops the turn; one or two never do', async () => {
    const spies = newSpies();
    const toasts: string[] = [];
    const setup = await mountComposer(fakeSession(spies, { isBusy: true }), spies, (message) =>
      toasts.push(message),
    );

    await pressEscape(setup);
    expect(spies.cancel).not.toHaveBeenCalled();
    expect(toasts).toContain('Esc 2 more times to stop');

    await pressEscape(setup);
    expect(spies.cancel).not.toHaveBeenCalled();
    expect(toasts).toContain('Esc once more to stop');

    await pressEscape(setup);
    expect(spies.cancel).toHaveBeenCalledTimes(1);
    expect(toasts).toContain('Stopping…');
  });

  test('Esc on an empty idle input does nothing — the app owns back', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies), spies);
    await pressEscape(setup);
    expect(spies.cancel).not.toHaveBeenCalled();
    expect(spies.onCommand).not.toHaveBeenCalled();
  });
});

describe('slash commands in the input', () => {
  async function type(setup: TestRendererSetup, text: string): Promise<void> {
    await act(async () => {
      await setup.mockInput.typeText(text, 1);
    });
    await setup.renderOnce();
  }
  async function enter(setup: TestRendererSetup): Promise<void> {
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await setup.renderOnce();
  }

  test('/ opens the menu with the built-ins and the project command; the slash stays typed', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies), spies);
    await type(setup, '/');
    const text = frame(setup);
    expect(text).toContain('/sessions');
    expect(text).toContain('/new');
    expect(text).toContain('Tab complete');
    await type(setup, 'dep');
    expect(frame(setup)).toContain('/deploy');
  });

  test('/sessions + Enter hands the command to the app', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies), spies);
    await type(setup, '/sessions');
    await enter(setup);
    expect(spies.onCommand).toHaveBeenCalledWith('sessions', '');
    expect(spies.send).not.toHaveBeenCalled();
  });

  test('a command with arguments carries them: /rename New title', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies), spies);
    await type(setup, '/rename Fix the login bug');
    expect(frame(setup)).toContain('/rename <title>');
    await enter(setup);
    expect(spies.onCommand).toHaveBeenCalledWith('rename', 'Fix the login bug');
  });

  test('an alias runs its command: /switch is /sessions', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies), spies);
    await type(setup, '/switch');
    await enter(setup);
    expect(spies.onCommand).toHaveBeenCalledWith('sessions', '');
  });

  test('↓ then Enter runs the second row of the filtered menu', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies), spies);
    // `/se`: sessions first, then the next prefix match.
    await type(setup, '/se');
    await act(async () => {
      setup.mockInput.pressArrow('down');
    });
    await enter(setup);
    expect(spies.onCommand).toHaveBeenCalledTimes(1);
    expect(spies.onCommand.mock.calls[0]?.[0]).not.toBe('sessions');
  });

  test('a project command runs through session.runCommand', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies), spies);
    await type(setup, '/deploy');
    await enter(setup);
    expect(spies.runCommand).toHaveBeenCalledWith('deploy', '');
  });

  test('an unknown /word is refused and kept, never sent to the model', async () => {
    const spies = newSpies();
    const toasts: string[] = [];
    const setup = await mountComposer(fakeSession(spies), spies, (message) => toasts.push(message));
    await type(setup, '/nosuch thing');
    await enter(setup);
    expect(spies.send).not.toHaveBeenCalled();
    expect(toasts.some((message) => message.startsWith('Unknown command /nosuch'))).toBe(true);
    expect(frame(setup)).toContain('/nosuch thing');
  });

  test('a path is text: /etc/hosts is broken goes to the model', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies), spies);
    await type(setup, '/etc/hosts is broken');
    await enter(setup);
    expect(spies.send).toHaveBeenCalledWith('/etc/hosts is broken');
  });

  test('a mid-line slash stays text and opens no menu', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies), spies);
    await type(setup, 'cd /workspace');
    const text = frame(setup);
    expect(text).toContain('cd /workspace');
    expect(text).not.toContain('Tab complete');
  });

  test('/stop stops the running turn inside the composer', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies, { isBusy: true }), spies);
    await type(setup, '/stop');
    await enter(setup);
    expect(spies.cancel).toHaveBeenCalledTimes(1);
    expect(spies.onCommand).not.toHaveBeenCalled();
  });

  test('Esc closes the menu without sending', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies), spies);
    await type(setup, '/');
    await pressEscape(setup);
    expect(frame(setup)).not.toContain('Tab complete');
    expect(spies.send).not.toHaveBeenCalled();
  });
});

describe('the pickers', () => {
  test('Alt+M lists the models grouped by provider, and Enter persists the pick', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies), spies);
    await act(async () => {
      setup.mockInput.pressKey('m', { meta: true });
    });
    await setup.renderOnce();

    const text = frame(setup);
    expect(text).toContain('Model');
    expect(text).toContain('Anthropic');
    expect(text).toContain('OpenAI');
    expect(text).toContain('Claude Sonnet 5');
    expect(text).toContain('GPT-5.6 Sol');
    // The unavailable model stays listed and is marked.
    expect(text).toContain('O9 Preview');
    expect(text).toContain('off');
    // The Anthropic heading sorts before the OpenAI one.
    const lines = text.split('\n');
    const anthropic = lines.findIndex((line) => line.includes('Anthropic'));
    const openai = lines.findIndex((line) => line.includes('OpenAI'));
    expect(anthropic).toBeGreaterThanOrEqual(0);
    expect(anthropic).toBeLessThan(openai);

    await act(async () => {
      setup.mockInput.pressEnter();
    });
    expect(spies.setModel).toHaveBeenCalledTimes(1);
    expect(spies.setModel.mock.calls[0]?.[0]).toEqual({
      providerID: 'kortix',
      modelID: 'anthropic/claude-sonnet-5',
      provider: 'anthropic',
    });
  });

  test('the model picker refuses a model the project turned off', async () => {
    const spies = newSpies();
    const toasts: string[] = [];
    const setup = await mountComposer(fakeSession(spies), spies, (message) => toasts.push(message));
    await act(async () => {
      setup.mockInput.pressKey('m', { meta: true });
    });
    await act(async () => {
      await setup.mockInput.typeText('O9', 1);
    });
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    expect(spies.setModel).not.toHaveBeenCalled();
    expect(toasts.join(' ')).toContain('turned off');
  });

  test('Alt+G lists the agents with the default marked and persists the pick', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies), spies);
    await act(async () => {
      setup.mockInput.pressKey('g', { meta: true });
    });
    await setup.renderOnce();
    const text = frame(setup);
    expect(text).toContain('Agent');
    expect(text).toContain('galileo');
    expect(text).toContain('reviewer');
    expect(text).toContain('default');

    await act(async () => {
      setup.mockInput.pressArrow('down');
    });
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    expect(spies.setAgent).toHaveBeenCalledWith('reviewer');
  });

  test('Alt+E lists Auto plus the selected model variants', async () => {
    const spies = newSpies();
    const session = fakeSession(spies, {
      picks: {
        model: { providerID: 'kortix', modelID: 'anthropic/claude-sonnet-5' },
        agent: null,
        // `SessionPicks` carries the variant too; a partial mock that omits it
        // is not assignable (TS2352) and breaks `tsc --noEmit`.
        variant: null,
        setModel: spies.setModel,
        setAgent: spies.setAgent,
        setVariant: spies.setVariant,
      },
    } as Partial<SessionState>);
    const setup = await mountComposer(session, spies);
    await act(async () => {
      setup.mockInput.pressKey('e', { meta: true });
    });
    await setup.renderOnce();
    const text = frame(setup);
    expect(text).toContain('Thinking effort');
    expect(text).toContain('Auto');
    expect(text).toContain('Low');
    expect(text).toContain('High');
  });

  test('picking an effort writes it to the session picks, not a model store', async () => {
    const spies = newSpies();
    const session = fakeSession(spies, {
      picks: {
        model: { providerID: 'kortix', modelID: 'anthropic/claude-sonnet-5' },
        agent: null,
        variant: null,
        setModel: spies.setModel,
        setAgent: spies.setAgent,
        setVariant: spies.setVariant,
      },
    } as Partial<SessionState>);
    const setup = await mountComposer(session, spies);
    await act(async () => {
      setup.mockInput.pressKey('e', { meta: true });
    });
    await act(async () => {
      setup.mockInput.pressArrow('down');
    });
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    // `SessionPicks.setVariant` IS the send path: `sendParts` falls back to
    // `picks.variant`, so a pick applies to the next prompt with no override.
    expect(spies.setVariant).toHaveBeenCalledWith('low');
  });

  test('a prompt sent now carries no overrides — sendParts reads the picks', async () => {
    const spies = newSpies();
    const session = fakeSession(spies, {
      picks: {
        model: { providerID: 'kortix', modelID: 'anthropic/claude-sonnet-5' },
        agent: 'galileo',
        variant: 'high',
        setModel: spies.setModel,
        setAgent: spies.setAgent,
        setVariant: spies.setVariant,
      },
    } as Partial<SessionState>);
    const setup = await mountComposer(session, spies);
    await act(async () => {
      await setup.mockInput.typeText('hello', 1);
    });
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    expect(spies.send).toHaveBeenCalledWith('hello');
  });

  test('/model opens the model picker', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies), spies);
    await act(async () => {
      await setup.mockInput.typeText('/model', 1);
    });
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await setup.renderOnce();
    const text = frame(setup);
    expect(text).toContain('Model');
    expect(text).toContain('Claude Sonnet 5');
  });
});

describe('/copy and /export', () => {
  const reply = {
    message_id: 'm2',
    thread_id: 'main',
    seq: 2,
    role: 'assistant',
    kind: 'turn',
    status: 'complete',
    in_context: true,
    producer: { harness: 'pi' },
    created_at: '2026-10-30T00:00:00.000Z',
    blocks: [{ block_id: 'b', type: 'text', text: 'The fix is in.' }],
  };

  async function mountWith(spies: Spies, seams: { copied: string[]; written: [string, string][] }) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 } },
    });
    const setup = await testRender(
      <QueryClientProvider client={queryClient}>
        <Composer
          session={fakeSession(spies)}
          projectId="project-1"
          sessionId="1a2b3c4d-session"
          focused
          width={60}
          context={CONTEXT}
          onCommand={spies.onCommand}
          messages={[reply] as never}
          title="Fix the login bug"
          copyText={async (text) => {
            seams.copied.push(text);
            return { ok: true };
          }}
          writeFile={async (path, text) => {
            seams.written.push([path, text]);
          }}
        />
      </QueryClientProvider>,
      { width: 60, height: 30 },
    );
    active = setup;
    return setup;
  }

  test('/copy puts the last reply on the clipboard, inside the composer', async () => {
    const spies = newSpies();
    const seams = { copied: [] as string[], written: [] as [string, string][] };
    const setup = await mountWith(spies, seams);
    await act(async () => {
      await setup.mockInput.typeText('/copy', 1);
    });
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    expect(seams.copied).toEqual(['The fix is in.']);
    expect(spies.onCommand).not.toHaveBeenCalled();
  });

  test('/export writes Markdown to the named file', async () => {
    const spies = newSpies();
    const seams = { copied: [] as string[], written: [] as [string, string][] };
    const setup = await mountWith(spies, seams);
    await act(async () => {
      await setup.mockInput.typeText('/export notes.md', 1);
    });
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    expect(seams.written[0]?.[0]).toEndWith('/notes.md');
    expect(seams.written[0]?.[1]).toContain('## Kortix\n\nThe fix is in.');
  });

  test('the default export name is the slugged title plus the session id', () => {
    expect(exportFileName('Fix the login bug!', '1a2b3c4d-xyz')).toBe('kortix-fix-the-login-bug-1a2b3c4d.md');
    expect(exportFileName('', '1a2b3c4d-xyz')).toBe('kortix-1a2b3c4d.md');
  });
});
