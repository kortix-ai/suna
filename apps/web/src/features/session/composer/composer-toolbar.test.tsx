import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { TooltipProvider } from '@/components/ui/tooltip';
import { ComposerToolbar } from './composer-toolbar';

/**
 * Matrix row 18 — `TokenProgress` must render at EVERY viewport.
 *
 * A `hidden sm:flex` wrapper around it removed the ring below 640px, and with
 * it the only route to `SessionContextModal` (`session-chat.tsx`'s
 * `handleContextClick` has exactly one reference), so context usage and
 * compaction were unreachable on a phone.
 *
 * These assert on the RENDERED MARKUP, never on this file's own source text —
 * a test that greps its own component for a class name would pass on a comment
 * and prove nothing. `renderToStaticMarkup` needs no jsdom and commits no
 * effects, which is the same shell `attachment-tiles.test.tsx` and
 * `projects/project-card.test.tsx` already use.
 */

const noop = () => {};

function render(): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={noop}>
      {/* Both providers live higher up the tree in the app than this
          component: the toolbar's own tooltips need one, and a descendant
          selector reads through TanStack Query. Neither needs a DOM. Retries
          off so nothing is scheduled by a render that is thrown away. */}
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TooltipProvider>
            <ComposerToolbar
          onAttachClick={noop}
          agents={[]}
          selectedAgent={null}
          agentSelectorLocked={false}
          models={[]}
          selectedModel={null}
          modelRequired={false}
          variants={[]}
          selectedVariant={null}
          messages={[]}
          projectId={undefined}
          onContextClick={noop}
          onTranscription={noop}
          voiceDisabled={false}
          isSending={false}
          isBusy={false}
          stopDisabled={false}
          escCount={0}
          lockForQuestion={false}
          questionCanAct
          hasText={false}
          canSubmit={false}
          submitDisabled={false}
          disabled={false}
          modelUnavailable={false}
          onSubmit={noop}
          />
        </TooltipProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

/**
 * The `class` attribute of every element that is an ANCESTOR of the first
 * `<svg>` carrying the token-progress ring's marker class.
 *
 * Walks the raw markup with a tag depth counter rather than a DOM: push each
 * open tag's class onto a stack, pop on close, and snapshot the stack the
 * moment the marker element appears. Self-closing and void tags never nest, so
 * they are pushed and popped in one step.
 */
function ancestorClassesOf(html: string, marker: string): string[] {
  const stack: string[] = [];
  const tagRe = /<(\/)?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^"'>])*?)(\/)?>/g;
  const voids = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'path', 'circle', 'source']);

  for (const m of html.matchAll(tagRe)) {
    const [, closing, tag, attrs, selfClosed] = m;
    if (closing) {
      stack.pop();
      continue;
    }
    const cls = /class="([^"]*)"/.exec(attrs ?? '')?.[1] ?? '';
    if (attrs?.includes(marker)) return [...stack];
    if (selfClosed || voids.has(tag.toLowerCase())) continue;
    stack.push(cls);
  }
  throw new Error(`marker ${marker} not found in rendered markup`);
}

describe('ComposerToolbar — TokenProgress is visible at every viewport (matrix row 18)', () => {
  test('the token-progress ring is actually rendered', () => {
    // Guards the two assertions below: if the ring stopped rendering
    // altogether they would vacuously "find no hidden ancestor".
    expect(render()).toContain('data-slot="token-progress"');
  });

  test('no ancestor of the ring hides it below the sm breakpoint', () => {
    const ancestors = ancestorClassesOf(render(), 'data-slot="token-progress"');

    // The exact regression: a wrapper with `hidden sm:flex`. `hidden` is
    // display:none until the 640px breakpoint, so ANY unprefixed `hidden` on
    // an ancestor removes the control on a phone.
    const hiding = ancestors.filter((cls) => /(^|\s)hidden(\s|$)/.test(cls));
    expect(hiding).toEqual([]);
  });

  test('no ancestor of the ring carries a breakpoint-gated display class', () => {
    const ancestors = ancestorClassesOf(render(), 'data-slot="token-progress"');

    // Broader than the `hidden` check above: catches `sm:flex`, `md:block`,
    // `max-sm:hidden` and friends — any attempt to make this control's
    // presence depend on viewport width.
    const responsive = ancestors.filter((cls) =>
      /(^|\s)(max-)?(sm|md|lg|xl|2xl):(flex|block|inline|inline-flex|grid|hidden)(\s|$)/.test(cls),
    );
    expect(responsive).toEqual([]);
  });
});
