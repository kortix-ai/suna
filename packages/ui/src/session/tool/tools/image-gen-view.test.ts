import { toolCallBlock, type ToolCallBlock } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import type { ToolPart } from '../../../internal/session-types';
import {
  formatElapsed,
  imageGenView,
  imagePathKey,
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
        error: 'Connect Codex to use this model. Connect your ChatGPT account in the model picker, then try again.',
      }),
    );
    expect(view.phase).toBe('failed');
    expect(view.error).toEqual({
      message: 'Connect Codex to use this model.',
      suggestion: 'Connect your ChatGPT account in the model picker, then try again.',
      connectChatGpt: true,
    });
  });

  test('an error that names the reauth code also offers the connect action', () => {
    const view = imageGenView(
      call({ status: 'error', input: INPUT, error: 'provider_reauth_required: Your ChatGPT login expired.' }),
    );
    expect(view.phase).toBe('failed');
    expect(view.error?.connectChatGpt).toBe(true);
    expect(view.error?.message).toBe('Your ChatGPT login expired.');
  });

  test('a rate limit error is failed without the connect action', () => {
    const view = imageGenView(
      call({ status: 'error', input: INPUT, error: 'Image limit reached. Try again in 2 hours.' }),
    );
    expect(view.phase).toBe('failed');
    expect(view.error).toEqual({ message: 'Image limit reached.', suggestion: 'Try again in 2 hours.', connectChatGpt: false });
  });

  test('an aborted call maps to stopped', () => {
    expect(imageGenView(call({ status: 'error', input: INPUT, error: 'The operation was aborted.' })).phase).toBe('stopped');
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

test('formatElapsed prints minutes and zero-padded seconds', () => {
  expect(formatElapsed(0)).toBe('0:00');
  expect(formatElapsed(42_900)).toBe('0:42');
  expect(formatElapsed(125_000)).toBe('2:05');
  expect(formatElapsed(-5)).toBe('0:00');
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
    expect(imagePathKey('/workspace/output/images/fox.png')).toBe(imagePathKey('output/images/fox.png'));
  });

  test('a show of only that image is drawn already; a show that adds a PDF is not', () => {
    const paths = imagePathsShownByImageGen([imageGen]);
    expect(showDrawnByImageGen({ type: 'image', path: '/workspace/output/images/fox.png' }, paths)).toBe(true);
    const items = [
      { type: 'image', path: 'output/images/fox.png' },
      { type: 'file', path: '/workspace/report.pdf' },
    ];
    expect(showDrawnByImageGen({ items }, paths)).toBe(false);
    expect(showDrawnByImageGen({ items: JSON.stringify(items) }, paths)).toBe(false);
    expect(withoutImageGenDuplicates(items, paths)).toEqual([{ type: 'file', path: '/workspace/report.pdf' }]);
  });

  test('nothing is dropped without an image_gen image', () => {
    const paths = imagePathsShownByImageGen([show({ type: 'image', path: '/workspace/x.png' })]);
    expect(paths.size).toBe(0);
    expect(showDrawnByImageGen({ type: 'image', path: '/workspace/x.png' }, paths)).toBe(false);
  });
});
