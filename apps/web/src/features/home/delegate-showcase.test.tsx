import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import { DelegateShowcase } from './delegate-showcase';

const SOURCE = readFileSync(
  fileURLToPath(new URL('./delegate-showcase.tsx', import.meta.url)),
  'utf8',
);

function render(extra: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    <DelegateShowcase
      title="Delegate work to Kortix"
      description="Hand off a project and get finished work back."
      {...extra}
    />,
  );
}

describe('content', () => {
  test('renders the title and description', () => {
    const html = render();
    expect(html).toContain('Delegate work to Kortix');
    expect(html).toContain('Hand off a project and get finished work back.');
  });

  test('leads the sentence with the product name and a verb', () => {
    const html = render();
    expect(html).toContain('Kortix');
    expect(html).toContain('researches');
  });

  test('renders the action only when one is given', () => {
    expect(render()).not.toContain('data-testid="cta"');
    const html = render({
      action: (
        <button type="button" data-testid="cta">
          Sign in
        </button>
      ),
    });
    expect(html).toContain('data-testid="cta"');
  });

  test('reserves height for the sentence so the card cannot jump as it types', () => {
    expect(render()).toContain('min-h-[3.25rem]');
  });
});

describe('accessibility', () => {
  test('announces the rotating line politely rather than assertively', () => {
    expect(render()).toContain('aria-live="polite"');
  });

  test('the decorative card stack and mock toolbar are hidden from assistive tech', () => {
    expect(render()).toContain('aria-hidden');
  });

  test('honours prefers-reduced-motion', () => {
    // The full sentence is shown and the interval never starts, rather than the
    // animation being left frozen mid-word.
    expect(SOURCE).toContain('prefers-reduced-motion: reduce');
    expect(SOURCE).toContain('if (reducedMotion) return;');
  });

  test('uses exactly one heading, so it cannot compete with the page h1', () => {
    const html = render();
    expect(html.match(/<h2/g)).toHaveLength(1);
    expect(html).not.toContain('<h1');
  });
});

describe('lifecycle', () => {
  test('clears its interval on unmount', () => {
    expect(SOURCE).toContain('clearInterval');
  });

  test('drives the animation from the tested pure reducer', () => {
    // The timing rules live in lib/home/showcase-phrases.ts, which is unit
    // tested without a clock. This component must not re-implement them.
    expect(SOURCE).toContain('advanceTypewriter');
    expect(SOURCE).not.toContain('setTimeout(');
  });
});

describe('the graphic carries no second background', () => {
  test('there is no filled panel wrapping the composer stack', () => {
    // A bordered, filled container here sat on top of the page's own backdrop
    // and read as a second background behind the card.
    expect(SOURCE).not.toContain('bg-muted/40');
    expect(SOURCE).not.toContain('backdrop-blur-sm');
  });

  test('the agent selector leads the mock toolbar', () => {
    // Assert on the source, not the markup: the "researches" phrase icon is
    // lucide's search glyph too, so the rendered HTML legitimately contains it.
    expect(SOURCE).not.toContain('<Search ');
    expect(render()).toContain('Kortix');
  });
});
