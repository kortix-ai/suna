import { describe, expect, test } from 'bun:test';
import { convertCallouts } from './codemod-docs-mdx.mjs';

describe('convertCallouts', () => {
  test('maps warn to :::warning with a title', () => {
    const input = `<Callout type="warn" title="Deletion is permanent">\nGone for good.\n</Callout>`;
    expect(convertCallouts(input)).toBe(`:::warning[Deletion is permanent]\nGone for good.\n:::`);
  });

  test('maps info to :::info', () => {
    const input = `<Callout type="info" title="Spend order">\nCredits first.\n</Callout>`;
    expect(convertCallouts(input)).toBe(`:::info[Spend order]\nCredits first.\n:::`);
  });

  test('maps an untyped Callout to :::note', () => {
    const input = `<Callout>\nJust a note.\n</Callout>`;
    expect(convertCallouts(input)).toBe(`:::note\nJust a note.\n:::`);
  });

  test('removes the fumadocs Callout import line', () => {
    const input = `import { Callout } from 'fumadocs-ui/components/callout';\n\nBody.`;
    expect(convertCallouts(input)).toBe(`Body.`);
  });

  test('leaves an import INSIDE a fenced code block untouched', () => {
    const input = '```ts\nimport { Callout } from \'fumadocs-ui/components/callout\';\n```';
    expect(convertCallouts(input)).toBe(input);
  });
});
