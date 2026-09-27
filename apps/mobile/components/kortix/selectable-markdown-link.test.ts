import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// RN selectable Text captures taps before a nested link's onPress on Android.
test('transcript inline link remains pressable inside selectable markdown', () => {
  const source = readFileSync(import.meta.dir + '/selectable-markdown.tsx', 'utf8');
  const linkRule = source.match(/link: \(node: AstNode,[\s\S]*?\n    \),/)?.[0];
  expect(linkRule).toContain('onPress={() => openExternalLink(node.attributes?.href)}');
  expect(linkRule).not.toMatch(/\bselectable\b/);
  expect(source).toContain('<RNText key={node.key} style={styles.textgroup}>');
});
