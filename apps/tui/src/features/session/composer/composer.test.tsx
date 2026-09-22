import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';

import type { TestRendererSetup } from '@opentui/core/testing';
import { testRender } from '@opentui/react/test-utils';

import { initKortix, resetKortixForTest } from '../../../kortix.ts';
import { Composer, type SessionState } from './composer.tsx';
import { BUILTIN_COMMANDS, commandItems, resolveCommandItem } from './slash-commands.ts';

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
      { name: 'review', path: '.opencode/command/review.md', description: 'Review the diff' },
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

async function mountComposer(session: SessionState, spies: Spies): Promise<TestRendererSetup> {
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
        onCommand={spies.onCommand as unknown as (id: 'new') => void}
      />
    </QueryClientProvider>,
    { width: 60, height: 24 },
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
    expect(frame(setup)).toContain('Type / for skills, commands, and files');

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
    expect(frame(setup)).toContain('Type / for skills, commands, and files');
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

  test('the footer states the model, effort and agent', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies), spies);
    const text = frame(setup);
    expect(text).toContain('Auto');
    expect(text).toContain('galileo');
    expect(text).toContain('Enter sends');
  });

  test('a send error renders one line under the composer', async () => {
    const spies = newSpies();
    const session = fakeSession(spies, {
      sendError: { kind: 'billing', message: 'Out of credits' },
    } as Partial<SessionState>);
    const setup = await mountComposer(session, spies);
    expect(frame(setup)).toContain('billing: Out of credits');
  });

  test('a busy session says Enter queues', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies, { isBusy: true }), spies);
    expect(frame(setup)).toContain('Enter queues');
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

  test('Esc twice on an empty busy composer stops the agent', async () => {
    const spies = newSpies();
    const toasts: string[] = [];
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 } },
    });
    const setup = await testRender(
      <QueryClientProvider client={queryClient}>
        <Composer
          session={fakeSession(spies, { isBusy: true })}
          projectId="project-1"
          sessionId="session-1"
          focused
          width={60}
          onCommand={spies.onCommand as unknown as (id: 'new') => void}
          onToast={(message) => toasts.push(message)}
        />
      </QueryClientProvider>,
      { width: 60, height: 24 },
    );
    active = setup;

    await pressEscape(setup);
    expect(spies.cancel).not.toHaveBeenCalled();
    expect(toasts).toContain('Esc again to stop');
    expect(frame(setup)).toContain('Esc again to stop');

    await pressEscape(setup);
    expect(spies.cancel).toHaveBeenCalledTimes(1);
    expect(spies.onCommand).toHaveBeenCalledWith('stop');
  });

  test('Esc on an empty idle composer does nothing — the app owns back', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies), spies);
    await pressEscape(setup);
    expect(spies.cancel).not.toHaveBeenCalled();
    expect(spies.onCommand).not.toHaveBeenCalled();
  });
});

describe('the / command palette', () => {
  test('/ at column 0 opens the palette with the runtime command and the built-ins', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies), spies);
    await act(async () => {
      await setup.mockInput.typeText('/', 1);
    });
    await setup.renderOnce();

    const text = frame(setup);
    expect(text).toContain('Commands');
    expect(text).toContain('/review');
    expect(text).toContain('/new');
    expect(text).toContain('/model');
    // The slash itself never reaches the buffer.
    expect(text).toContain('Type / for skills, commands, and files');
  });

  test('a mid-line slash stays text', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies), spies);
    await act(async () => {
      await setup.mockInput.typeText('cd /workspace', 1);
    });
    await setup.renderOnce();
    const text = frame(setup);
    expect(text).toContain('cd /workspace');
    expect(text).not.toContain('Commands');
  });

  test('picking /new calls onCommand("new") and closes the palette', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies), spies);
    await act(async () => {
      await setup.mockInput.typeText('/', 1);
    });
    // Filter down to the built-in, then take it.
    await act(async () => {
      await setup.mockInput.typeText('new', 1);
    });
    await setup.renderOnce();
    expect(frame(setup)).toContain('/new');

    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await setup.renderOnce();

    expect(spies.onCommand).toHaveBeenCalledWith('new');
    expect(frame(setup)).not.toContain('Commands');
  });

  test('picking a runtime command runs it through session.runCommand', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies), spies);
    await act(async () => {
      await setup.mockInput.typeText('/', 1);
    });
    await act(async () => {
      await setup.mockInput.typeText('review', 1);
    });
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    expect(spies.runCommand).toHaveBeenCalledWith('review', '');
  });

  test('Esc closes the palette without sending', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies), spies);
    await act(async () => {
      await setup.mockInput.typeText('/', 1);
    });
    await pressEscape(setup);
    expect(frame(setup)).not.toContain('Commands');
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
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 } },
    });
    const setup = await testRender(
      <QueryClientProvider client={queryClient}>
        <Composer
          session={fakeSession(spies)}
          projectId="project-1"
          sessionId="session-1"
          focused
          width={60}
          onCommand={spies.onCommand as unknown as (id: 'new') => void}
          onToast={(message) => toasts.push(message)}
        />
      </QueryClientProvider>,
      { width: 60, height: 24 },
    );
    active = setup;
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

  test('/model opens the model picker instead of leaving the palette open', async () => {
    const spies = newSpies();
    const setup = await mountComposer(fakeSession(spies), spies);
    await act(async () => {
      await setup.mockInput.typeText('/', 1);
    });
    await act(async () => {
      await setup.mockInput.typeText('model', 1);
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

describe('slash-command data', () => {
  test('runtime commands come first and ids never collide with the built-ins', () => {
    const items = commandItems([{ name: 'new', description: 'a project command called new' }]);
    expect(items[0]?.id).toBe('runtime:new');
    expect(items.filter((item) => item.id === 'builtin:new')).toHaveLength(1);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  });

  test('a non-array command payload degrades to the built-ins', () => {
    const items = commandItems({ nope: true } as unknown as undefined);
    expect(items).toHaveLength(BUILTIN_COMMANDS.length);
  });

  test('resolveCommandItem routes each id', () => {
    expect(resolveCommandItem('runtime:review')).toEqual({ kind: 'runtime', name: 'review' });
    expect(resolveCommandItem('builtin:new')).toEqual({ kind: 'app', id: 'new' });
    expect(resolveCommandItem('builtin:model')).toEqual({ kind: 'picker', id: 'model' });
    expect(resolveCommandItem('builtin:nope')).toBeNull();
    expect(resolveCommandItem('whatever')).toBeNull();
  });
});
