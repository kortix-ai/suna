import { describe, expect, test } from 'bun:test';
import { convertCallouts } from './codemod-docs-mdx.mjs';
import { convertSteps } from './codemod-docs-mdx.mjs';
import { convertCards, PHOSPHOR_TO_LUCIDE } from './codemod-docs-mdx.mjs';

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

describe('convertCards', () => {
  test('renames Cards to CardGroup', () => {
    expect(convertCards('<Cards>\n</Cards>')).toBe('<CardGroup>\n</CardGroup>');
  });

  test('converts a JSX icon element to a Lucide name string', () => {
    const input = `<Card icon={<RocketIcon />} title="Quickstart" href="/docs/quickstart">Go.</Card>`;
    expect(convertCards(input)).toBe(
      `<Card icon="rocket" title="Quickstart" href="/docs/quickstart">Go.</Card>`,
    );
  });

  test('drops the docs-card and icons/ssr imports', () => {
    const input =
      `import { Card, Cards } from '@/components/markdown/docs-card';\n` +
      `import { RocketIcon } from '@/lib/icons/ssr';\n\nBody.`;
    expect(convertCards(input)).toBe('Body.');
  });

  test('drops a multi-line icons/ssr import', () => {
    const input = `import {\n  CloudIcon,\n  CodeIcon,\n} from '@/lib/icons/ssr';\n\nBody.`;
    expect(convertCards(input)).toBe('Body.');
  });

  test('maps every icon the docs actually use', () => {
    // All 25 measured in the spec. A missing entry means a silently iconless card.
    for (const phosphor of [
      'TerminalIcon', 'RobotIcon', 'PlugsConnectedIcon', 'PathIcon', 'KeyIcon',
      'GitBranchIcon', 'DesktopIcon', 'CubeIcon', 'ChatsIcon', 'BrainIcon',
      'AlarmIcon', 'UsersIcon', 'ShareNetworkIcon', 'ScrollIcon', 'RocketIcon',
      'GitPullRequestIcon', 'FlagIcon', 'FileTextIcon', 'CpuIcon', 'CodeIcon',
      'CloudIcon', 'ClipboardTextIcon', 'BrowserIcon', 'BookOpenIcon', 'AtomIcon',
    ]) {
      expect(PHOSPHOR_TO_LUCIDE[phosphor]).toBeTruthy();
    }
  });

  test('throws on an unmapped icon rather than dropping it silently', () => {
    expect(() => convertCards('<Card icon={<NotARealIcon />} title="x">y</Card>')).toThrow(
      /Unmapped icon/,
    );
  });

  test('leaves a Cards example, a Card icon, and the icons/ssr import INSIDE a fenced code block untouched', () => {
    const input =
      '```mdx\n' +
      "import { RocketIcon } from '@/lib/icons/ssr';\n" +
      '<Cards>\n' +
      '  <Card icon={<RocketIcon />} title="x">y</Card>\n' +
      '</Cards>\n' +
      '```';
    expect(convertCards(input)).toBe(input);
  });

  test('does not let a non-target multi-line import lookahead cross a fence boundary', () => {
    // A bare multi-line import from some OTHER module, outside any fence,
    // whose own close line does not match the docs-card/icons-ssr target —
    // followed by prose, then a fenced block containing a real multi-line
    // icons/ssr import (so its close line DOES match CARD_IMPORT_CLOSE) and
    // a Cards/Card example. The unbounded lookahead bug scans past the
    // fence-open delimiter looking for a '} from .../ssr';' close, finds
    // one deep inside the fence, swallows the delimiter as a dropped line,
    // desyncs inFence, and rewrites the fenced example. Nothing here is a
    // target: the whole input must survive verbatim.
    const input =
      "import {\n  foo,\n} from 'some-other-module';\n\n" +
      'Some prose in between.\n\n' +
      '```mdx\n' +
      "import {\n  BrainIcon,\n} from '@/lib/icons/ssr';\n" +
      '<Cards>\n' +
      '  <Card icon={<BrainIcon />} title="x">y</Card>\n' +
      '</Cards>\n' +
      '```';
    expect(convertCards(input)).toBe(input);
  });
});
