import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';

import { TurnAssistantBlock } from './transcript';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
// The streaming cadence paces on animation frames; Bun has none. Scoped to this file, so no other test sees them.
const hadFrames = 'requestAnimationFrame' in globalThis;
beforeAll(() => {
  if (hadFrames) return;
  globalThis.requestAnimationFrame = ((fn: FrameRequestCallback) => setTimeout(() => fn(performance.now()), 16)) as never;
  globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as never;
});
afterAll(() => {
  if (hadFrames) return;
  delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
  delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
});

const RESPONSE = 'Here are the options.\n\n- One\n- Two\n\n<kortix_system type="note">internal</kortix_system>';
const t = Object.assign((key: string) => key, { raw: (key: string) => key }) as never;

/** A text-only turn (no steps), streaming or settled; `inline` uses the text-and-questions flow. */
const BLOCK = { type: 'text', id: 'p1', text: RESPONSE };
function turn(working: boolean, inline: boolean) {
  const parts = [{ type: 'text', id: 'p1', block: BLOCK }];
  // While working, the response's one text block is the open one (`useTurnModelState`).
  const openText = working ? { block: BLOCK, messageId: 'm1' } : null;
  return (
    <TurnAssistantBlock
      turn={{} as never}
      model={{ working, openText, hasSteps: false, hasReasoning: false, response: RESPONSE } as never}
      answered={{ shouldUseInlineContent: inline, inlineContentParts: inline ? parts : null, answeredQuestionCalls: [] } as never}
      userContent={{ commandOutput: null } as never}
      tHardcodedUi={t}
    />
  );
}

let mounted: ReactTestRenderer | null = null;
afterEach(async () => {
  await act(async () => mounted?.unmount());
  mounted = null;
});

/** `UnifiedMarkdown` is a memo: its fiber carries the inner component as `type`. */
const markdownOf = (renderer: ReactTestRenderer) => renderer.root.find((node) => node.type === (UnifiedMarkdown as unknown as { type: unknown }).type);
/** The markdown's root element: a host node, as its DOM node would be. */
const rootOf = (renderer: ReactTestRenderer) =>
  renderer.root.find((node) => node.type === 'div' && String(node.props.className).includes('kortix-markdown'));
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 1500)));

describe('the turn response keeps one component tree across the turn end', () => {
  for (const inline of [false, true]) {
    test(`${inline ? 'inline text flow' : 'settled response'}: the markdown instance survives streaming → settled`, async () => {
      await act(async () => {
        mounted = create(turn(true, inline));
      });
      await settle();
      const streaming = markdownOf(mounted!);
      const root = rootOf(mounted!);
      expect(streaming.props.isStreaming).toBe(true);

      await act(async () => mounted!.update(turn(false, inline)));
      await settle();
      const settled = markdownOf(mounted!);
      // The same fibers: React kept the subtree, so a generative UI block inside it does not remount.
      expect(settled).toBe(streaming);
      expect(rootOf(mounted!)).toBe(root);
      expect(settled.props.isStreaming).toBe(false);
      // Settled, the text renders as SandboxUrlDetector did: system tags stripped.
      expect(JSON.stringify(mounted!.toJSON())).not.toContain('internal');
    });
  }
});
