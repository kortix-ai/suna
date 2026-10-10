import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import * as trackModule from '@/lib/track';

import { GenuiTelemetryContext, type GenuiTelemetryScope } from './block-telemetry';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

// Host-level contract of generative UI in markdown: who opts in, when a block streams, when telemetry fires.

const BLOCK = 'root = Stack([a, b])\na = Stat("Revenue", "12k")\nb = Callout("info", "Book by Friday")';
// `r` names a StatRow with one Stat: only the relaxed streaming schema accepts it, the settled parse drops it.
const RELAXED = 'root = Stack([r, ok])\nr = StatRow([a, b])\na = Stat("Revenue", "12k")\nok = Badge("kept")';
const fenced = (code: string) => `Here it is:\n\n\`\`\`openui\n${code}\n\`\`\``;

let mounted: ReactTestRenderer | null = null;
async function mount(node: ReactElement): Promise<ReactTestRenderer> {
  await act(async () => {
    mounted = create(node);
  });
  // The block chunk is lazy: wait for it (up to 5 s on a loaded machine), then let Streamdown's block effect settle.
  const tick = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  const loaded = () => mounted!.root.findAll((node) => node.props['data-genui-block'] !== undefined).length > 0;
  for (let i = 0; i < 500 && !loaded(); i++) await tick();
  for (let i = 0; i < 5; i++) await tick();
  return mounted!;
}
async function unmount() {
  await act(async () => mounted?.unmount());
  mounted = null;
}

const textOf = (renderer: ReactTestRenderer): string => {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') parts.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object' && 'children' in node) walk((node as { children: unknown }).children);
  };
  walk(renderer.toJSON());
  return parts.join(' ');
};

let trackSpy: Mock<typeof trackModule.track>;
beforeEach(() => {
  trackSpy = spyOn(trackModule, 'track').mockImplementation(() => {});
});
afterEach(async () => {
  await unmount();
  trackSpy.mockRestore();
});

describe('generative UI is opt-in per markdown surface', () => {
  test('a surface without `genui` renders the fence as an ordinary code block', () => {
    const html = renderToStaticMarkup(<UnifiedMarkdown trust="agent" content={fenced(BLOCK)} />);
    expect(html).toContain('<pre');
    expect(html).toContain('Stack([a, b])');
  });

  test('transcript assistant text (`genui`) never shows the source', () => {
    const html = renderToStaticMarkup(<UnifiedMarkdown trust="agent" genui content={fenced(BLOCK)} />);
    expect(html).not.toContain('Stack([a, b])');
    expect(html).not.toContain('<pre');
  });
});

describe('a block streams only while its own fence is open', () => {
  test('an open block in a working turn streams: a node valid only while streaming shows', async () => {
    const renderer = await mount(<UnifiedMarkdown trust="agent" genui isStreaming content={`Here it is:\n\n\`\`\`openui\n${RELAXED}\n`} />);
    expect(textOf(renderer)).toContain('Revenue');
    expect(textOf(renderer)).toContain('kept');
  });

  test('a closed block in a still-working turn is settled at once: the strict parse applies', async () => {
    const renderer = await mount(<UnifiedMarkdown trust="agent" genui isStreaming content={`${fenced(RELAXED)}\n\nNow checking the`} />);
    expect(textOf(renderer)).not.toContain('Revenue');
    expect(textOf(renderer)).toContain('kept');
  });
});

describe('genui_block telemetry', () => {
  const scope: GenuiTelemetryScope = { scope: 'turn-telemetry-1', model: 'model-a' };
  const withScope = (node: ReactElement, value: GenuiTelemetryScope = scope) => (
    <GenuiTelemetryContext.Provider value={value}>{node}</GenuiTelemetryContext.Provider>
  );

  test('fires once when the host swaps the streaming tree for the settled one', async () => {
    await mount(withScope(<UnifiedMarkdown trust="agent" genui isStreaming content={`Here it is:\n\n\`\`\`openui\n${BLOCK.slice(0, 30)}`} />));
    expect(trackSpy).not.toHaveBeenCalled();
    await unmount();
    // Text-only turn: the settled response is a different element (transcript.tsx TurnSettledResponse).
    await mount(withScope(<UnifiedMarkdown trust="agent" genui content={fenced(BLOCK)} />));
    await unmount();
    await mount(withScope(<UnifiedMarkdown trust="agent" genui content={fenced(BLOCK)} />));
    expect(trackSpy).toHaveBeenCalledTimes(1);
    const [event, properties] = trackSpy.mock.calls[0]!;
    expect(event).toBe('genui_block');
    expect(properties).toMatchObject({ outcome: 'rendered', cut_off: false, model: 'model-a', platform: 'web' });
    expect(JSON.stringify(properties)).not.toContain('Revenue');
  });

  test('fires when the fence closes while the turn still works, and not again after the swap', async () => {
    const value = { scope: 'turn-telemetry-2' };
    await mount(withScope(<UnifiedMarkdown trust="agent" genui isStreaming content={`${fenced(BLOCK)}\n\nMore`} />, value));
    expect(trackSpy).toHaveBeenCalledTimes(1);
    expect(trackSpy.mock.calls[0]![1]).not.toHaveProperty('model');
    await unmount();
    await mount(withScope(<UnifiedMarkdown trust="agent" genui content={`${fenced(BLOCK)}\n\nMore`} />, value));
    expect(trackSpy).toHaveBeenCalledTimes(1);
  });

  test('a reply cut off inside the fence reports cut_off', async () => {
    const value = { scope: 'turn-telemetry-3' };
    const cut = `Here it is:\n\n\`\`\`openui\n${BLOCK}`;
    await mount(withScope(<UnifiedMarkdown trust="agent" genui isStreaming content={cut} />, value));
    await unmount();
    await mount(withScope(<UnifiedMarkdown trust="agent" genui content={cut} />, value));
    expect(trackSpy).toHaveBeenCalledTimes(1);
    expect(trackSpy.mock.calls[0]![1]).toMatchObject({ cut_off: true });
  });

  test('history the viewer never watched stream does not report', async () => {
    await mount(withScope(<UnifiedMarkdown trust="agent" genui content={fenced(BLOCK)} />, { scope: 'turn-telemetry-4' }));
    expect(trackSpy).not.toHaveBeenCalled();
  });
});

describe('images inside a block', () => {
  test('a ranked item shows its image, and block images take no prose margin', async () => {
    const code = `root = Stack([list, pic])
list = RankedList([r1])
r1 = RankedItem("First", "Best overall", "4.8", "https://example.com/first.jpg")
pic = Image("https://example.com/venue.jpg", "Venue entrance", "The north door")`;
    const renderer = await mount(<UnifiedMarkdown trust="agent" genui content={fenced(code)} />);
    const images = renderer.root.findAll((node) => node.type === 'img');
    expect(images.map((node) => node.props.src)).toEqual(['https://example.com/first.jpg', 'https://example.com/venue.jpg']);
    for (const image of images) expect(String(image.parent?.props.className)).not.toContain('my-5');
  });
});

describe('a fence inside a list item or a blockquote streams like a top-level one', () => {
  // The tick ends mid-statement: a settled parse would add "Response was cut off." and drop the relaxed StatRow.
  const body = `${RELAXED}\nz = Badge("tr`;
  const indent = (prefix: string) => body.split('\n').map((line) => `${prefix}${line}`).join('\n');
  const shapes: [string, string][] = [
    ['an indented fence in a numbered list', `1. First step\n\n   \`\`\`openui\n${indent('   ')}`],
    ['a fence on the list marker line', `- \`\`\`openui\n${indent('  ')}`],
    ['a fence in a blockquote', `> \`\`\`openui\n${indent('> ')}`],
  ];
  for (const [name, content] of shapes) {
    test(name, async () => {
      const renderer = await mount(
        <GenuiTelemetryContext.Provider value={{ scope: `turn-nested-${name}` }}>
          <UnifiedMarkdown trust="agent" genui isStreaming content={content} />
        </GenuiTelemetryContext.Provider>,
      );
      expect(textOf(renderer)).toContain('Revenue');
      expect(textOf(renderer)).not.toContain('cut off');
      expect(textOf(renderer)).not.toContain('root = Stack');
      expect(trackSpy).not.toHaveBeenCalled();
    });
  }
});
