// Moved from packages/ui `session/tool/tools/image-gen-view.test.ts` (Ruling R15).
import { describe, expect, test } from 'bun:test';

import type { ToolPart } from '../../runtime/client';
import { toolCallBlock } from '../../session-log/tool-call';
import type { ToolCallBlock } from '../../session-log/types';
import * as root from '../../../index';
import {
  formatImageGenElapsed,
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

const INPUT = { action: 'generate', prompts: ['A paper-cutout fox'], aspect_ratio: '3:2' };
/** A Phase 1 call: one `prompt` and a pixel `size`. */
const LEGACY_INPUT = { action: 'generate', prompt: 'A paper-cutout fox', size: '1536x1024' };
const OUTPUT = JSON.stringify({
  action: 'generate',
  model: 'codex/gpt-image-2',
  provider: 'openai-codex',
  images: [{ path: '/workspace/output/images/fox.png', size: '1254x836', prompt: 'A paper-cutout fox' }],
});
const THREE = ['A fox in a shuttle', 'An owl in a shuttle', 'A hare in a shuttle'];

test('the root barrel exports the image card mapping', () => {
  expect(root.imageGenView).toBe(imageGenView);
  expect(root.showDrawnByImageGen).toBe(showDrawnByImageGen);
});

describe('imageGenView', () => {
  test('a running call maps to generating with one frame at the requested aspect', () => {
    const view = imageGenView(call({ status: 'running', input: INPUT }));
    expect(view.phase).toBe('generating');
    expect(view.action).toBe('generate');
    expect(view.prompts).toEqual(['A paper-cutout fox']);
    expect(view.images).toEqual([
      { prompt: 'A paper-cutout fox', phase: 'generating', aspectRatio: '3 / 2', imagePath: null, directUrl: null, error: null },
    ]);
    expect(view.error).toBeNull();
  });

  test('a three-prompt call shows three generating frames', () => {
    const view = imageGenView(call({ status: 'running', input: { action: 'generate', prompts: THREE, aspect_ratio: '16:9' } }));
    expect(view.phase).toBe('generating');
    expect(view.prompts).toEqual(THREE);
    expect(view.images.map((image) => [image.prompt, image.phase, image.aspectRatio])).toEqual(
      THREE.map((prompt) => [prompt, 'generating', '16 / 9']),
    );
  });

  test('a call whose arguments have not parsed yet holds one frame', () => {
    const view = imageGenView(call({ status: 'running', input: {} }));
    expect(view.prompts).toEqual([]);
    expect(view.images).toHaveLength(1);
    expect(view.images[0]).toMatchObject({ prompt: '', phase: 'generating', aspectRatio: '1 / 1' });
  });

  test('aspect_ratio 16:9 gives a 16 / 9 placeholder', () => {
    const input = { ...INPUT, aspect_ratio: '16:9' };
    expect(imageGenView(call({ status: 'running', input })).images[0]!.aspectRatio).toBe('16 / 9');
    expect(imageGenView(call({ status: 'running', input: { ...input, aspect_ratio: '3:4' } })).images[0]!.aspectRatio).toBe('3 / 4');
    // aspect_ratio wins over a legacy size on the same call.
    expect(imageGenView(call({ status: 'running', input: { ...input, size: '1024x1024' } })).images[0]!.aspectRatio).toBe('16 / 9');
  });

  test('legacy size still works: a legacy prompt is one frame, aspect_ratio auto or absent reads size, then a square', () => {
    const legacy = imageGenView(call({ status: 'running', input: LEGACY_INPUT }));
    expect(legacy.prompts).toEqual(['A paper-cutout fox']);
    expect(legacy.images[0]!.aspectRatio).toBe('3 / 2');
    const ratio = (input: Record<string, unknown>) => imageGenView(call({ status: 'running', input })).images[0]!.aspectRatio;
    expect(ratio({ prompts: ['x'], aspect_ratio: 'auto', size: '1024x1536' })).toBe('2 / 3');
    expect(ratio({ prompts: ['x'], aspect_ratio: 'auto' })).toBe('1 / 1');
    expect(ratio({ prompts: ['x'], aspect_ratio: 'wide' })).toBe('1 / 1');
    expect(ratio({ prompt: 'x', size: 'auto' })).toBe('1 / 1');
  });

  test('a completed batch output maps to ready, each image at its delivered size', () => {
    const view = imageGenView(call({ status: 'completed', input: INPUT, output: OUTPUT }));
    expect(view.phase).toBe('ready');
    expect(view.images).toEqual([
      {
        prompt: 'A paper-cutout fox',
        phase: 'ready',
        aspectRatio: '3 / 2',
        imagePath: '/workspace/output/images/fox.png',
        directUrl: null,
        error: null,
      },
    ]);
  });

  test('the ready view exposes the model that made the images and its provider', () => {
    const out = JSON.stringify({
      action: 'generate',
      model: 'google/gemini-2.5-flash-image',
      provider: 'google',
      images: [{ path: '/workspace/output/images/fox.png', size: '1344x768', prompt: 'x' }],
    });
    const view = imageGenView(call({ status: 'completed', input: { prompts: ['x'], aspect_ratio: '16:9' }, output: out }));
    expect(view.model).toBe('google/gemini-2.5-flash-image');
    expect(view.provider).toBe('google');
    expect(view.images[0]!.aspectRatio).toBe('7 / 4');
    // Before the call completes, and for a legacy output without the fields, both are null.
    const running = imageGenView(call({ status: 'running', input: INPUT }));
    expect([running.model, running.provider]).toEqual([null, null]);
    const legacy = imageGenView(call({ status: 'completed', input: LEGACY_INPUT, output: '"/workspace/legacy/out.png"' }));
    expect([legacy.model, legacy.provider]).toEqual([null, null]);
  });

  test('a batch with one failure shows two images and one error, in prompt order', () => {
    const out = JSON.stringify({
      action: 'generate',
      model: 'codex/gpt-image-2',
      provider: 'openai-codex',
      images: [
        { path: '/workspace/output/images/fox.png', size: '1024x1024', prompt: THREE[0] },
        { path: '/workspace/output/images/hare.webp', size: '1536x1024', prompt: THREE[2] },
      ],
      failed: [
        {
          prompt: THREE[1],
          error: 'Image generation failed (400): The request was refused. Change the prompt, then retry. [content_policy]',
        },
      ],
    });
    const view = imageGenView(call({ status: 'completed', input: { action: 'generate', prompts: THREE }, output: out }));
    expect(view.phase).toBe('ready');
    expect(view.images.map((image) => [image.prompt, image.phase, image.imagePath])).toEqual([
      [THREE[0], 'ready', '/workspace/output/images/fox.png'],
      [THREE[1], 'failed', null],
      [THREE[2], 'ready', '/workspace/output/images/hare.webp'],
    ]);
    expect(view.images[1]!.error).toEqual({
      message: 'The request was refused.',
      suggestion: 'Change the prompt, then retry.',
      code: 'content_policy',
      connectModel: false,
    });
    expect(view.images[1]!.aspectRatio).toBe('1 / 1');
    expect(view.images[2]!.aspectRatio).toBe('3 / 2');
    expect(view.error).toBeNull();
  });

  test('a per-image failure with a connect code offers the connect action for that frame', () => {
    const out = JSON.stringify({
      action: 'generate',
      images: [{ path: '/workspace/output/images/a.png', size: '1024x1024', prompt: 'a' }],
      failed: [{ prompt: 'b', error: 'Image generation failed (401): The ChatGPT login expired. Reconnect ChatGPT in Models, then retry. [provider_reauth_required]' }],
    });
    const view = imageGenView(call({ status: 'completed', input: { prompts: ['a', 'b'] }, output: out }));
    expect(view.images[1]!.error).toMatchObject({ code: 'provider_reauth_required', connectModel: true });
  });

  test('a batch entry the call did not ask for still renders, after the asked ones', () => {
    const out = JSON.stringify({ images: [{ path: '/workspace/output/images/b.png', prompt: 'b, trimmed' }, { path: '/workspace/output/images/a.png', prompt: 'a' }] });
    const view = imageGenView(call({ status: 'completed', input: { prompts: ['a', 'b'] }, output: out }));
    expect(view.images.map((image) => image.imagePath)).toEqual(['/workspace/output/images/a.png', '/workspace/output/images/b.png']);
  });

  test('legacy single path output still renders', () => {
    const single = JSON.stringify({ path: '/workspace/output/images/fox.png', action: 'generate', size: '1254x836', model: 'gpt-image-2' });
    const view = imageGenView(call({ status: 'completed', input: LEGACY_INPUT, output: single }));
    expect(view.phase).toBe('ready');
    expect(view.model).toBe('gpt-image-2');
    expect(view.images).toEqual([
      {
        prompt: 'A paper-cutout fox',
        phase: 'ready',
        aspectRatio: '3 / 2',
        imagePath: '/workspace/output/images/fox.png',
        directUrl: null,
        error: null,
      },
    ]);
    // The delivered size replaces the requested size for the aspect (Ruling R2).
    const auto = JSON.stringify({ path: '/workspace/output/images/a.png', size: '1374x1145' });
    expect(imageGenView(call({ status: 'completed', input: { ...LEGACY_INPUT, size: 'auto' }, output: auto })).images[0]!.aspectRatio).toBe('6 / 5');
    // A bare, possibly quoted image path.
    expect(imageGenView(call({ status: 'completed', input: LEGACY_INPUT, output: '"/workspace/legacy/out.png"' })).images[0]!.imagePath).toBe(
      '/workspace/legacy/out.png',
    );
    expect(imageGenView(call({ status: 'completed', input: LEGACY_INPUT, output: 'workspace/legacy/out.jpeg' })).images[0]!.imagePath).toBe(
      '/workspace/legacy/out.jpeg',
    );
  });

  test('a JPEG or WebP image renders like a PNG', () => {
    for (const path of ['/workspace/output/images/fox.jpg', '/workspace/output/images/fox.webp']) {
      const out = JSON.stringify({ model: 'xai/grok-imagine-image', provider: 'xai', images: [{ path, size: '1024x768', prompt: 'x' }] });
      const view = imageGenView(call({ status: 'completed', input: { prompts: ['x'] }, output: out }));
      expect(view.images[0]).toMatchObject({ phase: 'ready', imagePath: path, aspectRatio: '4 / 3' });
    }
  });

  test('a completed call with no image at all is a failed card', () => {
    const view = imageGenView(call({ status: 'completed', input: INPUT, output: JSON.stringify({ images: [] }) }));
    expect(view.phase).toBe('failed');
    expect(view.images).toEqual([]);
    expect(imageGenView(call({ status: 'completed', input: INPUT, output: 'no image here' })).phase).toBe('failed');
  });

  test('an edit call keeps its action', () => {
    expect(imageGenView(call({ status: 'running', input: { ...INPUT, action: 'edit' } })).action).toBe('edit');
  });

  test('a provider_not_connected error maps to a failed card with the connect action', () => {
    const view = imageGenView(
      call({
        status: 'error',
        input: INPUT,
        error:
          'Image generation failed (400): Connect Codex to use this model. Connect your ChatGPT account in Models, then retry. [provider_not_connected]',
      }),
    );
    expect(view.phase).toBe('failed');
    expect(view.images).toEqual([]);
    expect(view.prompts).toEqual(['A paper-cutout fox']);
    expect(view.error).toEqual({
      message: 'Connect Codex to use this model.',
      suggestion: 'Connect your ChatGPT account in Models, then retry.',
      code: 'provider_not_connected',
      connectModel: true,
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
    expect(view.error).toMatchObject({ message: 'The ChatGPT login expired.', code: 'provider_reauth_required', connectModel: true });
  });

  test('image_model_unavailable maps to connectModel', () => {
    const view = imageGenView(
      call({
        status: 'error',
        input: INPUT,
        error:
          'Image generation failed (400): No image model is available for this project. Connect ChatGPT, or add an OpenAI, Google, xAI or OpenRouter key in project settings. [image_model_unavailable]',
      }),
    );
    expect(view.phase).toBe('failed');
    expect(view.error).toEqual({
      message: 'No image model is available for this project.',
      suggestion: 'Connect ChatGPT, or add an OpenAI, Google, xAI or OpenRouter key in project settings.',
      code: 'image_model_unavailable',
      connectModel: true,
    });
  });

  test('a model refusal that a connection cannot fix offers no connect action', () => {
    for (const code of ['not_an_image_model', 'image_model_unpriced', 'image_model_unsupported', 'image_rate_limited']) {
      const view = imageGenView(
        call({ status: 'error', input: INPUT, error: `Image generation failed (400): That model cannot answer. [${code}]` }),
      );
      expect(view.error).toMatchObject({ code, connectModel: false });
    }
  });

  test('prose that talks about connecting ChatGPT, with no code, offers no connect action', () => {
    const view = imageGenView(
      call({ status: 'error', input: INPUT, error: 'Connect your ChatGPT account to generate images.' }),
    );
    expect(view.phase).toBe('failed');
    expect(view.error?.connectModel).toBe(false);
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
      connectModel: false,
    });
  });

  test('a tool refusal with no gateway code stays a plain failure', () => {
    const view = imageGenView(call({ status: 'error', input: INPUT, error: 'Image limit for this turn reached (10).' }));
    expect(view.error).toEqual({ message: 'Image limit for this turn reached (10).', connectModel: false });
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
    expect(view.images).toEqual([]);
    expect(view.error).toBeNull();
  });

  test('an error that only mentions an interruption or a timeout is a failure, not a stop', () => {
    expect(imageGenView(call({ status: 'error', input: INPUT, error: 'Upstream connection interrupted.' })).phase).toBe('failed');
    expect(imageGenView(call({ status: 'error', input: INPUT, error: 'The operation timed out.' })).phase).toBe('failed');
  });

  test('an open call on a turn that ended is stopped; a live or unknown turn keeps it generating', () => {
    const running = call({ status: 'running', input: INPUT });
    expect(imageGenView(running, false).phase).toBe('stopped');
    expect(imageGenView(running, false).images).toEqual([]);
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
      call({ status: 'completed', input: LEGACY_INPUT, output: JSON.stringify({ replicate_url: 'https://replicate.delivery/x.png' }) }),
    );
    expect(view.phase).toBe('ready');
    expect(view.images[0]!.directUrl).toBe('https://replicate.delivery/x.png');
  });

  test('a new image_gen output never renders a remote URL', () => {
    const view = imageGenView(
      call({ status: 'completed', input: LEGACY_INPUT, output: JSON.stringify({ path: '/workspace/output/images/a.png', url: 'https://evil.example/p.gif' }) }),
    );
    expect(view.images[0]!.imagePath).toBe('/workspace/output/images/a.png');
    expect(view.images[0]!.directUrl).toBeNull();
    // A batch image is a sandbox path only, never a URL.
    const batch = imageGenView(
      call({ status: 'completed', input: INPUT, output: JSON.stringify({ images: [{ url: 'https://evil.example/p.gif', prompt: 'x' }] }) }),
    );
    expect(batch.phase).toBe('failed');
    // A non-http URL is never honoured either.
    expect(
      imageGenView(call({ status: 'completed', input: LEGACY_INPUT, output: JSON.stringify({ url: 'javascript:alert(1)' }) })).phase,
    ).toBe('failed');
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

  test('every image of a batch counts, a failed prompt adds nothing', () => {
    const batch = call({
      status: 'completed',
      input: { prompts: ['a', 'b', 'c'] },
      output: JSON.stringify({
        images: [
          { path: '/workspace/output/images/a.png', prompt: 'a' },
          { path: '/workspace/output/images/c.png', prompt: 'c' },
        ],
        failed: [{ prompt: 'b', error: 'Image generation failed (500): Upstream error.' }],
      }),
    });
    const legacy = call({ status: 'completed', input: LEGACY_INPUT, output: JSON.stringify({ path: '/workspace/output/images/old.png' }) });
    const paths = imagePathsShownByImageGen([batch, legacy]);
    expect([...paths]).toEqual(['output/images/a.png', 'output/images/c.png', 'output/images/old.png']);
    expect(showDrawnByImageGen(show({ items: [{ type: 'image', path: 'output/images/a.png' }, { type: 'image', path: '/workspace/output/images/c.png' }] }), paths)).toBe(true);
  });

  test('a show path matches with or without the /workspace prefix', () => {
    const paths = imagePathsShownByImageGen([imageGen]);
    expect([...paths]).toEqual(['output/images/fox.png']);
    expect(withoutImageGenDuplicates([{ path: '/workspace/output/images/fox.png' }], paths)).toEqual([]);
    expect(withoutImageGenDuplicates([{ path: 'output/images/fox.png' }], paths)).toEqual([]);
    expect(withoutImageGenDuplicates([{ path: 'workspace/output/images/fox.png' }], paths)).toEqual([]);
    expect(withoutImageGenDuplicates([{ path: '/workspace/output/images/other.png' }], paths)).toHaveLength(1);
  });

  test('the path key is not public API', () => {
    expect('imageGenPathKey' in root).toBe(false);
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
