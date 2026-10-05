import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(import.meta.dir + '/selectable-markdown.tsx', 'utf8');

// Android: a selectable outer Text swallows nested link taps unless it has a
// press handler of its own (KRTX-562). Both must hold: selection and link taps.
test('transcript text group is selectable and keeps inline link taps on Android', () => {
  expect(source).toContain('<MarkdownText key={node.key} style={styles.textgroup} selectable {...ANDROID_LINK_TAPS}>');
  expect(source).toMatch(/ANDROID_LINK_TAPS[^=]*=\s*Platform\.OS === 'android' \? \{ onPress: noop, accessibilityRole: 'text' \}/);
  const linkRule = source.match(/link: \(node: AstNode,[\s\S]*?\n    \),/)?.[0];
  expect(linkRule).toContain('onPress={() => openExternalLink(node.attributes?.href)}');
});

// iOS: every text rule renders MarkdownText, so nested spans stay inside one
// UITextView; a raw RNText span would become an inline view and break selection.
test('markdown text rules never render a raw RNText span', () => {
  const rules = source.slice(source.indexOf('const createMarkdownRules'), source.indexOf('/** `hr`'));
  for (const rule of ['text', 'textgroup', 'strong', 'em', 's', 'link']) {
    const body = rules.match(new RegExp(`\\n    ${rule}: \\([\\s\\S]*?\\n    \\),`))?.[0];
    expect(body).toContain('<MarkdownText');
    expect(body).not.toContain('<RNText');
  }
});
