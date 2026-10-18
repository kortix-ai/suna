import * as downloads from '@/lib/utils/download';
import { type SessionLogMessage } from '@kortix/sdk';
import { describe, expect, spyOn, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { SessionTrajectory, TrajectoryFullText, trajectoryText } from './session-trajectory';

describe('session trajectory', () => {
  test('empty history has a clear empty state', () => {
    expect(renderToStaticMarkup(<SessionTrajectory messages={[]} />)).toContain('No activity yet');
  });
  test('lists canonical messages in order with status and context', () => {
    const message = (
      message_id: string,
      role: SessionLogMessage['role'],
      text: string,
    ): SessionLogMessage => ({
      schema: 'kortix.session/2',
      v: 1,
      message_id,
      thread_id: 'root',
      seq: role === 'user' ? 0 : 1,
      role,
      kind: 'turn',
      status: 'complete',
      in_context: true,
      model: null,
      usage: null,
      finish: 'stop',
      error: null,
      created_at: '2026-01-01T00:00:00Z',
      completed_at: null,
      producer: { harness: 'pi', harness_version: '1', adapter_version: '1' },
      blocks: [{ id: message_id + '-text', type: 'text', text }],
    });
    const messages = [
      message('prompt', 'user', 'Inspect fixture'),
      message('reply', 'assistant', 'Done'),
    ];
    const html = renderToStaticMarkup(<SessionTrajectory messages={messages} />);
    expect(html.indexOf('user')).toBeLessThan(html.indexOf('assistant'));
    expect(html).toContain('Trajectory');
    expect(html).toContain('complete');
  });
  test('referenced text and tool results identify previews and offer the full text', () => {
    for (const block of [
      { id: 'text', type: 'text', text: 'preview', ref: 'attachment-ref', bytes: 32000 },
      {
        id: 'tool',
        type: 'tool_call',
        call_id: 'call',
        name: 'read',
        kind: 'read',
        input: {},
        status: 'complete',
        result: {
          is_error: false,
          content: [{ type: 'text', text: 'preview', ref: 'attachment-ref', bytes: 32000 }],
        },
      },
    ] satisfies import('@kortix/sdk').SessionLogBlock[]) {
      expect(trajectoryText(block)).toContain('Preview');
      expect(trajectoryText(block)).toContain('32000 bytes');
    }
  });
  test('tool inspection preserves inputs, outputs and semantic errors', () => {
    expect(
      trajectoryText({
        id: 'tool',
        type: 'tool_call',
        call_id: 'call',
        name: 'read',
        kind: 'read',
        input: { path: 'fixture.txt' },
        status: 'complete',
        result: {
          content: [{ type: 'text', text: 'missing fixture' }],
          is_error: true,
          error: { message: 'Not found' },
        },
      }),
    ).toContain('fixture.txt');
    expect(
      trajectoryText({
        id: 'tool',
        type: 'tool_call',
        call_id: 'call',
        name: 'read',
        kind: 'read',
        input: {},
        status: 'error',
        result: {
          content: [{ type: 'text', text: 'missing fixture' }],
          is_error: true,
          error: { message: 'Not found' },
        },
      }),
    ).toContain('Not found');
    expect(trajectoryText({ id: 'reason', type: 'reasoning', text: 'Check the fixture' })).toBe(
      'Check the fixture',
    );
    expect(
      trajectoryText({
        id: 'compact',
        type: 'compaction',
        summary: null,
        first_kept_message_id: null,
      }),
    ).toBe('Encrypted summary');
  });
});

test('full text uses the SDK, handles failure, and retries a download', async () => {
  const sdk = await import('@kortix/sdk');
  const fetch = spyOn(sdk, 'fetchSessionAttachment');
  const download = spyOn(downloads, 'downloadBlob').mockImplementation(() => {});
  const message: SessionLogMessage = {
    schema: 'kortix.session/2',
    v: 1,
    message_id: 'large',
    thread_id: 'root',
    seq: 0,
    role: 'assistant',
    kind: 'turn',
    status: 'complete',
    in_context: true,
    model: null,
    usage: null,
    finish: 'stop',
    error: null,
    created_at: '2026-01-01T00:00:00Z',
    completed_at: null,
    producer: { harness: 'pi', harness_version: '1', adapter_version: '1' },
    blocks: [{ id: 't', type: 'text', text: 'preview', ref: 'stored-text', bytes: 32000 }],
  };
  const renderer = create(<TrajectoryFullText message={message} />);
  try {
    await act(async () => {});
    expect(renderer.root.findByType('span').props.children).toBe(
      'A long text here shows its first 16 kB.',
    );
    expect(renderer.root.findByType('button').props.children).toBe('Download full text (32 kB)');
    fetch.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      await renderer.root.findByType('button').props.onClick();
    });
    expect(renderer.root.findByType('span').props.children).toBe('Could not load the full text.');
    expect(renderer.root.findByType('button').props.children).toBe('Try again');
    expect(download).not.toHaveBeenCalled();
    const blob = new Blob(['complete tool output']);
    fetch.mockResolvedValueOnce(blob);
    await act(async () => {
      await renderer.root.findByType('button').props.onClick();
    });
    expect(fetch).toHaveBeenLastCalledWith('stored-text');
    expect(download).toHaveBeenCalledWith(blob, 'full-text-1.txt');
    expect(renderer.root.findByType('button').props.children).toBe('Download full text (32 kB)');
  } finally {
    await act(async () => renderer.unmount());
    fetch.mockRestore();
    download.mockRestore();
  }
});
