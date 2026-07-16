import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PanelCard } from './panel-card';

describe('PanelCard headerAction (W15)', () => {
  test('renders the action beside the chevron', () => {
    const html = renderToStaticMarkup(
      <PanelCard
        title="Outputs"
        isEmpty={false}
        headerAction={<button type="button" aria-label="Download all" />}
      >
        <div>body</div>
      </PanelCard>,
    );
    expect(html).toContain('aria-label="Download all"');
  });

  test('omitted headerAction renders nothing extra beside the chevron', () => {
    const html = renderToStaticMarkup(
      <PanelCard title="Outputs" isEmpty={false}>
        <div>body</div>
      </PanelCard>,
    );
    expect(html).not.toContain('aria-label="Download all"');
  });

  test('the header trigger is never a <button> containing another <button> — invalid HTML', () => {
    const html = renderToStaticMarkup(
      <PanelCard
        title="Outputs"
        isEmpty={false}
        headerAction={<button type="button" aria-label="Download all" />}
      >
        <div>body</div>
      </PanelCard>,
    );
    // Tokenize every `<button ...>` open and `</button>` close in document
    // order, walking a stack: if we ever see an open tag while the stack is
    // already non-empty, a `<button>` is nested inside another `<button>`.
    const tokenRe = /<button[\s>]|<\/button>/g;
    let depth = 0;
    let maxDepth = 0;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(html))) {
      if (m[0].startsWith('</')) depth--;
      else {
        depth++;
        maxDepth = Math.max(maxDepth, depth);
      }
    }
    expect(depth).toBe(0); // every open tag closed — sanity check on the tokenizer itself
    expect(maxDepth).toBeLessThanOrEqual(1);
  });
});
