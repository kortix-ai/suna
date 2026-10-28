// Moved from packages/ui `session/tool/tools/image-gen-view.test.ts` (Ruling R15).
import { describe, expect, test } from 'bun:test';

import type { ToolPart } from '../../runtime/client';
import { toolCallBlock } from '../../session-log/tool-call';
import type { ToolCallBlock } from '../../session-log/types';
import * as root from '../../../index';
import {
  formatImageGenElapsed,
  imageGenPathKey,
  imageGenRetryDelay,
  imageGenView,
  imagePathsShownByImageGen,
  showDrawnByImageGen,
  withoutImageGenDuplicates,
} from './image-gen-view';

const START = 1_761_000_000_000;

function call(state: Record<string, unknown>, tool = 'image_gen'): ToolCallBlock {
  return toolCallBlock({
    type: 'tool',
    tool,
    callID: 'call-img-1',
    id: 'prt-img-1',
    messageID: 'msg-1',
    sessionID: 'ses-1',
    state: { time: { start: START }, ...state },
  } as unknown as ToolPart);
}

const INPUT = { action: 'generate', prompt: 'A paper-cutout fox', size: '1536x1024' };
const OUTPUT = JSON.stringify({
  path: '/workspace/output/images/fox.png',
  action: 'generate',
  size: '1254x836',
  model: 'gpt-image-2',
});

test('the root barrel exports the image card mapping', () => {
  expect(root.imageGenView).toBe(imageGenView);
  expect(root.showDrawnByImageGen).toBe(showDrawnByImageGen);
});

test('a legacy output that is a bare image path renders it', () => {
  const view = imageGenView(call({ status: 'completed', input: INPUT, output: '"/workspace/legacy/out.png"' }));
  expect(view.phase).toBe('ready');
  expect(view.imagePath).toBe('/workspace/legacy/out.png');
});

describe('imageGenView', () => {
  test('a running call maps to generating with the aspect of its size', () => {
    const view = imageGenView(call({ status: 'running', input: INPUT }));
    expect(view.phase).toBe('generating');
    expect(view.action).toBe('generate');
    expect(view.prompt).toBe('A paper-cutout fox');
    expect(view.aspectRatio).toBe('3 / 2');
    expect(view.imagePath).toBeNull();
    expect(view.error).toBeNull();
  });

  test('size auto and a missing size both hold a square placeholder', () => {
    expect(imageGenView(call({ status: 'running', input: { ...INPUT, size: 'auto' } })).aspectRatio).toBe('1 / 1');
    expect(imageGenView(call({ status: 'running', input: { prompt: 'x' } })).aspectRatio).toBe('1 / 1');
  });

  test('a completed JSON output maps to ready with the image path', () => {
    const view = imageGenView(
      call({ status: 'completed', input: INPUT, output: OUTPUT, time: { start: START, end: START + 20_000 } }),
    );
    expect(view.phase).toBe('ready');
    expect(view.imagePath).toBe('/workspace/output/images/fox.png');
    expect(view.directUrl).toBeNull();
    // The delivered size wins over the requested one (Ruling R2).
    expect(view.aspectRatio).toBe('3 / 2');
  });

  test('the delivered size replaces the requested size for the aspect', () => {
    const out = JSON.stringify({ path: '/workspace/output/images/a.png', action: 'generate', size: '1374x1145', model: 'gpt-image-2' });
    const view = imageGenView(call({ status: 'completed', input: { ...INPUT, size: 'auto' }, output: out }));
    expect(view.aspectRatio).toBe('6 / 5');
  });

  test('an edit call keeps its action', () => {
    expect(imageGenView(call({ status: 'running', input: { ...INPUT, action: 'edit' } })).action).toBe('edit');
  });

  test('a provider_not_connected error maps to failed with the connect action', () => {
    const view = imageGenView(
      call({
        status: 'error',
        input: INPUT,
        error:
          'Image generation failed (400): Connect Codex to use this model. Connect your ChatGPT account in Models, then retry. [provider_not_connected]',
      }),
    );
    expect(view.phase).toBe('failed');
    expect(view.error).toEqual({
      message: 'Connect Codex to use this model.',
      suggestion: 'Connect your ChatGPT account in Models, then retry.',
      code: 'provider_not_connected',
      connectChatGpt: true,
    });
  });

  test('the reauth code also offers the connect action', () => {
    const view = imageGenView(
      call({
        status: 'error',
        input: INPUT,
        error: 'Image generation failed (401): The ChatGPT login expired. Reconnect ChatGPT in Models, then retry. [provider_reauth_required]',
      }),
    );
    expect(view.error).toMatchObject({ message: 'The ChatGPT login expired.', code: 'provider_reauth_required', connectChatGpt: true });
  });

  test('prose that talks about connecting ChatGPT, with no code, offers no connect action', () => {
    const view = imageGenView(
      call({ status: 'error', input: INPUT, error: 'Connect your ChatGPT account to generate images.' }),
    );
    expect(view.phase).toBe('failed');
    expect(view.error?.connectChatGpt).toBe(false);
    expect(view.error?.code).toBeUndefined();
  });

  test('a rate limit keeps the retry time and the code out of the text', () => {
    const view = imageGenView(
      call({
        status: 'error',
        input: INPUT,
        error:
          'Image generation failed (429): The ChatGPT image limit is reached. Wait for the limit to reset, then retry. Retry after 7200 s. [image_rate_limited]',
      }),
    );
    expect(view.phase).toBe('failed');
    expect(view.error).toEqual({
      message: 'The ChatGPT image limit is reached.',
      suggestion: 'Wait for the limit to reset, then retry.',
      code: 'image_rate_limited',
      retryAfterSeconds: 7200,
      connectChatGpt: false,
    });
  });

  test('a tool refusal with no gateway code stays a plain failure', () => {
    const view = imageGenView(call({ status: 'error', input: INPUT, error: 'Image limit for this turn reached (10).' }));
    expect(view.error).toEqual({ message: 'Image limit for this turn reached (10).', connectChatGpt: false });
  });

  test('an aborted call maps to stopped', () => {
    // The tool's own fetch abort (Bun), and pi's tool loop on a stopped turn.
    expect(imageGenView(call({ status: 'error', input: INPUT, error: 'The operation was aborted.' })).phase).toBe('stopped');
    expect(imageGenView(call({ status: 'error', input: INPUT, error: 'Operation aborted' })).phase).toBe('stopped');
    // A call the run left open, closed at rest by the C2 rule.
    const interrupted: ToolCallBlock = {
      ...call({ status: 'running', input: INPUT }),
      status: 'error',
      result: { content: [{ type: 'text', text: 'No result provided' }], is_error: true, synthetic: true, error: { code: 'interrupted', message: 'No result provided' } },
    };
    const view = imageGenView(interrupted);
    expect(view.phase).toBe('stopped');
    expect(view.error).toBeNull();
  });

  test('an error that only mentions an interruption or a timeout is a failure, not a stop', () => {
    expect(imageGenView(call({ status: 'error', input: INPUT, error: 'Upstream connection interrupted.' })).phase).toBe('failed');
    expect(imageGenView(call({ status: 'error', input: INPUT, error: 'The operation timed out.' })).phase).toBe('failed');
  });

  test('an open call on a turn that ended is stopped; a live or unknown turn keeps it generating', () => {
    const running = call({ status: 'running', input: INPUT });
    expect(imageGenView(running, false).phase).toBe('stopped');
    expect(imageGenView(running, true).phase).toBe('generating');
    expect(imageGenView(running).phase).toBe('generating');
    // A finished call keeps its own outcome whatever the turn says.
    expect(imageGenView(call({ status: 'completed', input: INPUT, output: OUTPUT }), false).phase).toBe('ready');
  });

  test('elapsed time counts from the part start', () => {
    expect(imageGenView(call({ status: 'running', input: INPUT })).startedAt).toBe(START);
  });

  test('a legacy image_gen output with replicate_url still renders', () => {
    const view = imageGenView(
      call({ status: 'completed', input: INPUT, output: JSON.stringify({ replicate_url: 'https://replicate.delivery/x.png' }) }),
    );
    expect(view.phase).toBe('ready');
    expect(view.directUrl).toBe('https://replicate.delivery/x.png');
  });

  test('a new image_gen output never renders a remote URL', () => {
    const view = imageGenView(
      call({ status: 'completed', input: INPUT, output: JSON.stringify({ path: '/workspace/output/images/a.png', url: 'https://evil.example/p.gif' }) }),
    );
    expect(view.imagePath).toBe('/workspace/output/images/a.png');
    expect(view.directUrl).toBeNull();
    // A non-http URL is never honoured either.
    expect(
      imageGenView(call({ status: 'completed', input: INPUT, output: JSON.stringify({ url: 'javascript:alert(1)' }) })).directUrl,
    ).toBeNull();
  });
});

test('imageGenRetryDelay picks the largest whole unit', () => {
  expect(imageGenRetryDelay(45)).toEqual({ value: 45, unit: 'second' });
  expect(imageGenRetryDelay(600)).toEqual({ value: 10, unit: 'minute' });
  expect(imageGenRetryDelay(7200)).toEqual({ value: 2, unit: 'hour' });
});

test('formatImageGenElapsed prints minutes and zero-padded seconds', () => {
  expect(formatImageGenElapsed(0)).toBe('0:00');
  expect(formatImageGenElapsed(42_900)).toBe('0:42');
  expect(formatImageGenElapsed(125_000)).toBe('2:05');
  expect(formatImageGenElapsed(-5)).toBe('0:00');
});

describe('one image renders once (D5)', () => {
  const imageGen = call({ status: 'completed', input: INPUT, output: OUTPUT });
  const show = (input: Record<string, unknown>) => call({ status: 'completed', input, output: '' }, 'show');

  test('imagePathsShownByImageGen collects the completed image_gen paths of a turn', () => {
    const running = call({ status: 'running', input: INPUT });
    const paths = imagePathsShownByImageGen([imageGen, running, show({ type: 'image', path: '/workspace/x.png' })]);
    expect([...paths]).toEqual(['output/images/fox.png']);
  });

  test('a show path matches with or without the /workspace prefix', () => {
    expect(imageGenPathKey('/workspace/output/images/fox.png')).toBe(imageGenPathKey('output/images/fox.png'));
  });

  test('a show of only that image is drawn already; a show that adds a PDF is not', () => {
    const paths = imagePathsShownByImageGen([imageGen]);
    expect(showDrawnByImageGen(show({ type: 'image', path: '/workspace/output/images/fox.png' }), paths)).toBe(true);
    const items = [
      { type: 'image', path: 'output/images/fox.png' },
      { type: 'file', path: '/workspace/report.pdf' },
    ];
    expect(showDrawnByImageGen(show({ items }), paths)).toBe(false);
    expect(showDrawnByImageGen(show({ items: JSON.stringify(items) }), paths)).toBe(false);
    expect(withoutImageGenDuplicates(items, paths)).toEqual([{ type: 'file', path: '/workspace/report.pdf' }]);
  });

  test('only a show call can be drawn already: show_user and show-user count, other tools never do', () => {
    const paths = imagePathsShownByImageGen([imageGen]);
    const input = { type: 'image', path: '/workspace/output/images/fox.png' };
    expect(showDrawnByImageGen(call({ status: 'completed', input, output: '' }, 'show_user'), paths)).toBe(true);
    expect(showDrawnByImageGen(call({ status: 'completed', input, output: '' }, 'show-user'), paths)).toBe(true);
    expect(showDrawnByImageGen(call({ status: 'completed', input, output: '' }, 'read'), paths)).toBe(false);
  });

  test('nothing is dropped without an image_gen image', () => {
    const paths = imagePathsShownByImageGen([show({ type: 'image', path: '/workspace/x.png' })]);
    expect(paths.size).toBe(0);
    expect(showDrawnByImageGen(show({ type: 'image', path: '/workspace/x.png' }), paths)).toBe(false);
  });
});
