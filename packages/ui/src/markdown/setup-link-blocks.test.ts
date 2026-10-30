import { describe, expect, test } from 'bun:test';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { liftSetupLinkBlocks, type MdNode } from './setup-link-blocks';

const HUBSPOT = 'https://app.example.test/connect/ksl_hubspot0000';
const CANVA = 'https://app.example.test/connect/ksl_canva000000';
const TODOIST = 'https://app.example.test/connect/ksl_todoist0000';
const SECRET = 'https://app.example.test/secret-intake/ksl_secret00000';

function transform(markdown: string): MdNode {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as unknown as MdNode;
  liftSetupLinkBlocks(tree);
  return tree;
}

function blockTypes(tree: MdNode): string[] {
  return (tree.children ?? []).map((node) => node.type);
}

function linksOf(node: MdNode): Array<{ url: string; label: string }> {
  const out: Array<{ url: string; label: string }> = [];
  const walk = (n: MdNode) => {
    if (n.type === 'link') {
      out.push({ url: n.url ?? '', label: (n.children ?? []).map((c) => c.value ?? '').join('') });
      return;
    }
    n.children?.forEach(walk);
  };
  walk(node);
  return out;
}

describe('liftSetupLinkBlocks', () => {
  test('an App | Link table of connect links becomes one stack of links, labelled by app', () => {
    const tree = transform(
      [
        '| App | Link |',
        '| --- | --- |',
        `| HubSpot | [Connect HubSpot](${HUBSPOT}) |`,
        `| Canva | [Connect](${CANVA}) |`,
        `| Todoist | ${TODOIST} |`,
      ].join('\n'),
    );

    expect(blockTypes(tree)).toEqual(['paragraph']);
    expect(linksOf(tree)).toEqual([
      { url: HUBSPOT, label: 'Connect HubSpot' },
      { url: CANVA, label: 'Canva' },
      { url: TODOIST, label: 'Todoist' },
    ]);
  });

  test('a bullet list of connect links becomes the same stack, without bullets', () => {
    const tree = transform(
      [`- **HubSpot**: [Connect HubSpot](${HUBSPOT})`, `- [Connect Canva](${CANVA})`].join('\n'),
    );

    expect(blockTypes(tree)).toEqual(['paragraph']);
    expect(linksOf(tree).map((link) => link.url)).toEqual([HUBSPOT, CANVA]);
  });

  test('secret links lift too — the same card, the same chrome problem', () => {
    const tree = transform(['| Key | Link |', '| --- | --- |', `| Apollo | ${SECRET} |`].join('\n'));
    expect(blockTypes(tree)).toEqual(['paragraph']);
  });

  test('a table that carries real data beside the link is left a table', () => {
    const markdown = [
      '| App | Why | Link |',
      '| --- | --- | --- |',
      `| HubSpot | Pull last quarter's closed deals for the revenue report | ${HUBSPOT} |`,
    ].join('\n');
    expect(blockTypes(transform(markdown))).toEqual(['table']);
  });

  test('a table where one row has no setup link is left a table', () => {
    const markdown = [
      '| App | Link |',
      '| --- | --- |',
      `| HubSpot | ${HUBSPOT} |`,
      '| Slack | run `kortix channels connect` |',
    ].join('\n');
    expect(blockTypes(transform(markdown))).toEqual(['table']);
  });

  test('a list item that explains itself at length is left a list', () => {
    const markdown = `- HubSpot, so I can read every open deal and draft the follow-ups: ${HUBSPOT}`;
    expect(blockTypes(transform(markdown))).toEqual(['list']);
  });

  test('ordinary tables and lists without setup links are untouched', () => {
    const tree = transform(
      ['| A | B |', '| --- | --- |', '| 1 | [docs](https://example.test/docs) |', '', '- one', '- two'].join(
        '\n',
      ),
    );
    expect(blockTypes(tree)).toEqual(['table', 'list']);
  });

  test('a still-streaming setup link (pending href) lifts like a finished one', () => {
    const tree = transform(
      ['| App | Link |', '| --- | --- |', '| HubSpot | [Connect](#kortix-setup-link-pending:connector) |'].join(
        '\n',
      ),
    );
    expect(blockTypes(tree)).toEqual(['paragraph']);
  });

  test('the prose around the lifted block stays where it was', () => {
    const tree = transform(
      ['Connect these three apps:', '', `- ${HUBSPOT}`, `- ${CANVA}`, '', 'Then tell me when done.'].join(
        '\n',
      ),
    );
    expect(blockTypes(tree)).toEqual(['paragraph', 'paragraph', 'paragraph']);
    expect(linksOf(tree).map((link) => link.url)).toEqual([HUBSPOT, CANVA]);
  });
});
