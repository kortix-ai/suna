import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { TooltipProvider } from '@/components/ui/tooltip';
import { ComposerToolbar } from './composer-toolbar';

/**
 * `toolbarSlot` must actually RENDER.
 *
 * The prop existed, was destructured, and was never placed in the JSX — so the
 * session-overrides gear the project-home hero composer hands in through this
 * slot silently vanished on the index page (the hero's `'inline'` underbar
 * placement skips `ComposerUnderbar`, the slot's only other render site).
 * Nothing type-checked wrong and nothing failed; the control was just gone.
 *
 * Same shell as `composer-underbar.test.tsx`: `renderToStaticMarkup`, real
 * providers, assertions on the rendered markup — never on source text.
 */

const noop = () => {};

function render(
  toolbarSlot?: React.ReactNode,
  rewind?: { pending?: boolean; onRestore: () => void },
  send?: { agentUnavailable?: boolean; canSubmit?: boolean; submitDisabled?: boolean },
): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={noop}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <TooltipProvider>
          <ComposerToolbar
            models={[]}
            selectedModel={null}
            modelRequired={false}
            variants={[]}
            selectedVariant={null}
            projectId={undefined}
            toolbarSlot={toolbarSlot}
            rewind={rewind}
            onTranscription={noop}
            voiceDisabled={false}
            isSending={false}
            isBusy={false}
            stopDisabled={false}
            escCount={0}
            lockForQuestion={false}
            questionCanAct={false}
            hasText={false}
            canSubmit={send?.canSubmit ?? false}
            submitDisabled={send?.submitDisabled ?? false}
            disabled={false}
            modelUnavailable={false}
            agentUnavailable={send?.agentUnavailable}
            onSubmit={noop}
          />
        </TooltipProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

describe('ComposerToolbar toolbarSlot', () => {
  test('renders the slot content', () => {
    const html = render(<span data-testid="slot-sentinel">slot-sentinel-content</span>);
    expect(html).toContain('slot-sentinel-content');
  });

  test('renders nothing extra without a slot', () => {
    const html = render(undefined);
    expect(html).not.toContain('slot-sentinel-content');
  });
});

describe('ComposerToolbar voice input', () => {
  // Exactly the `toolbarSlot` failure above, one prop over: `onTranscription`
  // and `voiceDisabled` were declared, threaded from `composer.tsx`, and
  // destructured here — and `VoiceRecorder` was never placed in the JSX. The
  // whole dictation feature was unreachable from every composer in the app,
  // with nothing type-checking wrong.
  test('renders the microphone control', () => {
    const html = render(undefined);
    expect(html).toContain('aria-label="Start voice input"');
  });
});

describe('ComposerToolbar rewound-path control', () => {
  // The "Session rewound" notice moved off the input strip and onto this bar,
  // beside send/stop — send is the action that commits the rewound path. These
  // pin that the control actually renders, since the strip banner it replaced
  // is gone.

  test('renders a Restore control when the session is rewound', () => {
    const html = render(undefined, { onRestore: noop });
    expect(html).toContain('Restore');
  });

  test('shows the pending spinner while the restore is in flight', () => {
    const html = render(undefined, { pending: true, onRestore: noop });
    expect(html).toContain('Restore');
    // Loading renders a <svg> spinner in place of the rewind icon; the button
    // is disabled so a second click cannot race the restore.
    expect(html).toContain('disabled');
  });

  test('renders no Restore control on a normal path', () => {
    const html = render(undefined, undefined);
    expect(html).not.toContain('Restore');
  });
});

/**
 * The other half of the deny-by-default empty roster (see
 * `composer-agent-access.ts`): with no agent to run it, the send button must
 * refuse the prompt rather than POST one the server answers with a 403.
 */
describe('ComposerToolbar — send is refused with no accessible agent', () => {
  test('a typed draft normally leaves the send button enabled', () => {
    // Guard: without this the assertion below would pass on a button that was
    // disabled for having no text.
    const html = render(undefined, undefined, { canSubmit: true });
    const button = /<button[^>]*aria-label="Send message"[^>]*>/.exec(html)?.[0];

    expect(button).toBeDefined();
    // The attribute, not the substring: the class list carries
    // `disabled:pointer-events-none` on every Button.
    expect(button).not.toMatch(/\sdisabled=""/);
  });

  test('the send button is disabled and names the reason', () => {
    const html = render(undefined, undefined, {
      canSubmit: true,
      submitDisabled: true,
      agentUnavailable: true,
    });
    // The control's NAME stays "Send message" in every state — a screen reader
    // that hears "No agents available to you" and nothing else has lost what
    // the button DOES. The reason rides `title` (and the tooltip) instead.
    const button = /<button[^>]*aria-label="Send message"[^>]*>/.exec(html)?.[0];

    expect(button).toBeDefined();
    expect(button).toMatch(/\sdisabled=""/);
    // The exact line the agent picker's tooltip carries — one reason, one
    // wording, on both controls.
    expect(button).toContain('No agents available to you');
    expect(html).toContain('No agents available to you — ask a manager for access');
  });
});
