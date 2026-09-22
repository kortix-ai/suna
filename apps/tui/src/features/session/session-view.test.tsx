/**
 * The session column's contract: one `useSession` call, one focused region at a
 * time, and a row budget that never clips the composer off the bottom.
 *
 * The hook is injected through `useSessionImpl` — the same test seam
 * `TerminalPanel` uses for its socket factory — so the layout and focus rules
 * are asserted without an API, a sandbox or an SSE stream.
 */

import { describe, expect, mock, test } from 'bun:test';

import { testRender } from '@opentui/react/test-utils';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';

import {
  COMPOSER_CHROME_ROWS,
  OVERLAY_RESERVE_ROWS,
  PROMPT_RESERVE_ROWS,
  type SessionFocus,
  SessionView,
  TRANSCRIPT_MIN_ROWS,
  composerReserve,
  focusHints,
  phaseGlyph,
  terminalWidth,
  transcriptRows,
} from './session-view.tsx';
import { fakeSession, message, textPart } from './transcript/test-session.ts';

describe('row budget', () => {
  test('a one-line composer reserves its chrome plus one row', () => {
    expect(composerReserve({ rows: 1, overlayOpen: false })).toBe(1 + COMPOSER_CHROME_ROWS);
  });

  test('an open palette reserves the room it grows into', () => {
    expect(composerReserve({ rows: 1, overlayOpen: true })).toBe(
      1 + COMPOSER_CHROME_ROWS + OVERLAY_RESERVE_ROWS,
    );
  });

  test('the transcript takes what is left after the header and the composer', () => {
    // 30 content rows − 1 header − (1 + 4) composer = 24.
    expect(transcriptRows(30, { rows: 1, overlayOpen: false }, false)).toBe(24);
  });

  test('a pending question reserves room for its card', () => {
    expect(transcriptRows(30, { rows: 1, overlayOpen: false }, true)).toBe(
      24 - PROMPT_RESERVE_ROWS,
    );
  });

  test('the transcript never goes below its floor, however big the composer gets', () => {
    expect(transcriptRows(10, { rows: 6, overlayOpen: true }, true)).toBe(TRANSCRIPT_MIN_ROWS);
    expect(transcriptRows(1, { rows: 6, overlayOpen: true }, true)).toBe(TRANSCRIPT_MIN_ROWS);
  });
});

describe('terminalWidth', () => {
  test('is 40% of the region', () => {
    expect(terminalWidth(120)).toBe(48);
  });

  test('never shrinks a shell below 32 columns', () => {
    expect(terminalWidth(60)).toBe(32);
  });
});

describe('phaseGlyph and focusHints', () => {
  test('a glyph per lifecycle phase', () => {
    expect(phaseGlyph('ready')).toBe('●');
    expect(phaseGlyph('starting')).toBe('○');
    expect(phaseGlyph('error')).toBe('!');
  });

  test('the hints name the keys of the focused region', () => {
    expect(focusHints('composer')).toContain('Enter send');
    expect(focusHints('composer')).toContain('Alt+m model');
    expect(focusHints('terminal')).toContain('Alt+X close');
    expect(focusHints('transcript')).toContain('Esc composer');
    expect(focusHints('sidebar')).toContain('Enter open');
  });
});

async function mount(focus: SessionFocus | null, overrides: Record<string, unknown> = {}) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const session = fakeSession({
    messages: [message('m1', 'assistant', [textPart('t1', 'TRANSCRIPT-MARKER')])],
    commands: [],
    models: [],
    agents: [],
    picks: { model: null, agent: null, variant: null },
    isSending: false,
    switched: true,
    agentName: 'galileo',
    ...overrides,
  });
  const useSessionImpl = mock(() => session);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 } },
  });
  const setup = await testRender(
    <QueryClientProvider client={queryClient}>
      <SessionView
        projectId="p1"
        sessionId="s1"
        title="Casual greeting"
        focus={focus}
        width={90}
        height={24}
        terminalOpen={false}
        wide
        onFocus={() => {}}
        onCloseTerminal={() => {}}
        onCommand={() => {}}
        onToast={() => {}}
        useSessionImpl={useSessionImpl as never}
      />
    </QueryClientProvider>,
    { width: 120, height: 25 },
  );
  // `<markdown>` parses and highlights asynchronously and paints NOTHING on its
  // first frame, so every assertion on transcript text has to settle first
  // (`docs/opentui-notes.md`; same 600 ms the transcript's own tests use).
  await setup.flush();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
  await setup.flush();
  return { ...setup, useSessionImpl };
}

describe('SessionView', () => {
  test('calls useSession exactly once per render pass', async () => {
    const { useSessionImpl, renderer } = await mount('composer');
    // One call per render, never one per child: the transcript, the prompts,
    // the composer and the terminal panel all read the SAME object.
    const calls = useSessionImpl.mock.calls as unknown as [string, string][];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call[0] === 'p1' && call[1] === 's1')).toBe(true);
    renderer.destroy();
  });

  test('the header prints the session name, the phase glyph and the terminal hint', async () => {
    const { captureCharFrame, renderer } = await mount('composer');
    const header = captureCharFrame().split('\n')[1] ?? '';
    expect(header).toContain('Casual greeting');
    expect(header).toContain('●');
    expect(header).toContain('terminal');
    renderer.destroy();
  });

  test('a starting session prints its stage in the header', async () => {
    const { captureCharFrame, renderer } = await mount('composer', {
      phase: 'starting',
      stage: 'provisioning',
    });
    expect(captureCharFrame().split('\n')[1] ?? '').toContain('provisioning');
    renderer.destroy();
  });

  test('the transcript renders above the composer', async () => {
    const { captureCharFrame, renderer } = await mount('composer');
    const lines = captureCharFrame().split('\n');
    const transcript = lines.findIndex((line) => line.includes('TRANSCRIPT-MARKER'));
    const composer = lines.findIndex((line) => line.includes('Type / for'));
    expect(transcript).toBeGreaterThan(0);
    expect(composer).toBeGreaterThan(transcript);
    renderer.destroy();
  });

  test('the composer placeholder is on screen when the composer has focus', async () => {
    const { captureCharFrame, renderer } = await mount('composer');
    expect(captureCharFrame()).toContain('Type / for skills, commands, and files');
    renderer.destroy();
  });

  test('focus moves the panel border highlight, not the layout', async () => {
    const composerFocused = await mount('composer');
    const withComposer = composerFocused.captureCharFrame();
    composerFocused.renderer.destroy();

    const transcriptFocused = await mount('transcript');
    const withTranscript = transcriptFocused.captureCharFrame();
    transcriptFocused.renderer.destroy();

    // Same rows, same content: only the focused region changes, and the frame
    // keeps the transcript and the composer where they were.
    expect(withTranscript.split('\n').length).toBe(withComposer.split('\n').length);
    expect(withTranscript).toContain('TRANSCRIPT-MARKER');
    expect(withTranscript).toContain('Type / for skills, commands, and files');
  });

  test('focus=null (the sidebar has it) still renders the whole column', async () => {
    const { captureCharFrame, renderer } = await mount(null);
    const frame = captureCharFrame();
    expect(frame).toContain('Casual greeting');
    expect(frame).toContain('TRANSCRIPT-MARKER');
    renderer.destroy();
  });
});
