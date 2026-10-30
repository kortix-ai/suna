import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FoldedSection, OutputBlock, ToolField, ToolSection } from './output-block';

describe('OutputBlock', () => {
  test('renders mono, capped, token-styled output — never a bare pre', () => {
    const html = renderToStaticMarkup(<OutputBlock text="hello world" />);
    expect(html).toContain('hello world');
    expect(html).toContain('max-h-96');
    expect(html).toContain('data-scrollable');
    expect(html).toContain('whitespace-pre-wrap');
    expect(html).toContain('bg-muted/20');
  });
});

describe('ToolSection + ToolField', () => {
  test('one sanctioned label treatment; key→value rows', () => {
    const html = renderToStaticMarkup(
      <ToolSection label="Prompt">
        <ToolField label="Schedule" value="every 5m" mono />
      </ToolSection>,
    );
    expect(html).toContain('uppercase');
    expect(html).toContain('tracking-wider');
    expect(html).toContain('Prompt');
    expect(html).toContain('every 5m');
    expect(html).toContain('font-mono');
  });
});

// Task 20. The fold contract, tested on the primitive because `apps/web` has
// no DOM harness: a click cannot be simulated, so "closed hides it" and "open
// reveals it" are proven by rendering both states of the same component.
describe('FoldedSection', () => {
  test('closed by default: the label shows, the body is not in the markup', () => {
    const html = renderToStaticMarkup(
      <FoldedSection label="Facts (3)">
        <p>the extracted facts</p>
      </FoldedSection>,
    );

    expect(html).toContain('Facts (3)');
    expect(html).not.toContain('the extracted facts');
  });

  test('open reveals exactly that body', () => {
    const html = renderToStaticMarkup(
      <FoldedSection label="Facts (3)" defaultOpen>
        <p>the extracted facts</p>
      </FoldedSection>,
    );

    expect(html).toContain('Facts (3)');
    expect(html).toContain('the extracted facts');
  });

  test('the trigger carries the section label treatment and the disclosure a11y', () => {
    const html = renderToStaticMarkup(<FoldedSection label="Tags">tag</FoldedSection>);

    // Same 10px uppercase treatment as `ToolSection`, so a folded section and
    // an open one read as the same kind of thing.
    expect(html).toContain('uppercase');
    expect(html).toContain('tracking-wider');
    // Role, focusability and state come from `DisclosureTrigger` — nothing is
    // re-implemented here.
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-expanded="false"');
  });

  test('open reports its state on the trigger', () => {
    const html = renderToStaticMarkup(
      <FoldedSection label="Tags" defaultOpen>
        tag
      </FoldedSection>,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('rotate-90');
  });
});
