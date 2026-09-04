import { describe, expect, test } from 'bun:test';
import { convertCallouts } from './codemod-docs-mdx.mjs';
import { convertSteps } from './codemod-docs-mdx.mjs';

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

describe('convertSteps', () => {
  test('lifts the heading into a title prop', () => {
    const input = `<Step>\n### Install the CLI\n\nRun the install script.\n</Step>`;
    expect(convertSteps(input)).toBe(
      `<Step title="Install the CLI">\nRun the install script.\n</Step>`,
    );
  });

  test('leaves <Steps> wrappers in place', () => {
    const input = `<Steps>\n\n<Step>\n### One\n\nBody.\n</Step>\n\n</Steps>`;
    const out = convertSteps(input);
    expect(out).toContain('<Steps>');
    expect(out).toContain('<Step title="One">');
  });

  test('removes the fumadocs Steps import line', () => {
    const input = `import { Steps, Step } from 'fumadocs-ui/components/steps';\n\nBody.`;
    expect(convertSteps(input)).toBe(`Body.`);
  });

  test('does not touch a heading that is not a Step title', () => {
    const input = `### Just a heading\n\nBody.`;
    expect(convertSteps(input)).toBe(input);
  });
});
