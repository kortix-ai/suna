/**
 * `SessionChatInput` gives its four sheets props that keep one identity while
 * the user types, so the memoized sheets (Add, Recent files, Model,
 * AutoContinue) skip every keystroke. The sheets are stand-ins wrapped in
 * `React.memo`, the way the real modules export them; a render count above
 * the mount means a prop changed.
 *
 * It also pins what typing must still do: the Recent files pick appends to the
 * text as typed, and Send sends the text as typed.
 */
import { afterEach, beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import type { Command } from '@/lib/session/runtime-data';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as any).__DEV__ = true;
(globalThis as any).requestAnimationFrame ??= (callback: () => void) => setTimeout(callback, 0);

const source = readFileSync(import.meta.dir + '/SessionChatInput.tsx', 'utf8');
const Empty = () => null;
let suggestions: { items: { label: string; kind: string }[] } | undefined;
const sheetRenders: Record<string, number> = {};
const sheetProps: Record<string, any> = {};
function memoSheet(name: string) {
  return React.memo(
    React.forwardRef((props: any, _ref) => {
      sheetRenders[name] = (sheetRenders[name] ?? 0) + 1;
      sheetProps[name] = props;
      return null;
    }),
  );
}
let composer: any;
const sent: any[] = [];
const NO_FILES: any[] = [];
const NO_UPLOADS = {};
const attachments = { files: NO_FILES, uploads: NO_UPLOADS, add() {}, remove() {}, takeForSend: async () => ({ files: [], fileParts: [] }), clearAfterSend() {}, reclaim() {} };
const NO_ALGORITHMS: any[] = [];
const toast = { error() {} };

const moduleMocks: Record<string, Record<string, any>> = {
  'react-native': { View: ({ children }: any) => children ?? null, Pressable: ({ children }: any) => children ?? null, TextInput: Empty, StyleSheet: { create: (s: any) => s, hairlineWidth: 1 } },
  nativewind: { useColorScheme: () => ({ colorScheme: 'light' }) },
  '@/components/kortix/composer': { Composer: (props: any) => { composer = props; return null; }, COMPOSER_CONTROL_HIT_SLOP: 4 },
  './MentionSuggestions': { MentionSuggestions: (props: typeof suggestions) => { suggestions = props; return null; } },
  './AttachSheet': { AttachSheet: memoSheet('AttachSheet') },
  './SessionFilesSheet': { SessionFilesSheet: memoSheet('SessionFilesSheet') },
  './ModelPickerSheet': { ModelPickerSheet: memoSheet('ModelPickerSheet') },
  './autocontinue': {
    AutoContinueSheet: memoSheet('AutoContinueSheet'),
    useAutoContinue: () => {
      const [mode, setMode] = React.useState(null);
      return { mode, setMode, algorithms: NO_ALGORITHMS, current: null, dispatch: () => false };
    },
  },
  './useComposerAttachments': { useComposerAttachments: () => attachments },
  './useRecoverPendingPick': { useRecoverPendingPick() {} },
  '@/lib/session/use-composer-draft': { useComposerDraft() {} },
  '@/components/kortix/toast-provider': { useToast: () => toast },
  '@/lib/session/local-config': { useLocalConfigStore: (selector: any) => selector({ selectedAgent: null }) },
  './tool/shared/navigation': { useToolFilePreviewStore: { getState: () => ({ setAddToChat() {} }) } },
  './use-mention-file-search': { useMentionFileSearch: () => ({ results: NO_FILES, loading: false, clear() {} }) },
};
// Pure logic stays real: what typing and sending decide.
const KEEP_REAL = new Set([
  'react',
  './useMentions',
  './useSkillMentions',
  '@/lib/session/skill-mentions',
  '@/lib/session/send-plan',
  '@/lib/session/session-files',
  '@/lib/session/composer-config',
  '@/lib/session/model-picker',
]);

// Type-only imports are erased; mocking them would hide the real module from the kept-real ones.
for (const [, name] of source.matchAll(/^import (?!type )[^;]*?from ['"]([^'"]+)['"]/gms)) {
  if (KEEP_REAL.has(name)) continue;
  const values = { ...(moduleMocks[name] ?? {}) };
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [, names] of source.matchAll(new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*['"]${escaped}['"]`, 'gs'))) {
    for (const item of names.split(',')) {
      const key = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
      if (key && !(key in values)) values[key] = Empty;
    }
  }
  mock.module(name, () => ({ default: Empty, ...values }));
}
mock.module('./use-mention-file-search', () => moduleMocks['./use-mention-file-search']);

let SessionChatInput: typeof import('./SessionChatInput').SessionChatInput;
let tree: ReactTestRenderer | undefined;
const onSend = (...args: any[]) => sent.push(args);
const commands: Command[] = [
  { name: 'review', description: 'Review', source: 'skill', template: '', hints: [] },
  { name: 'build', description: 'Build', source: 'skill', template: '', hints: [] },
];

beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  ({ SessionChatInput } = await import('./SessionChatInput'));
});
beforeEach(() => {
  for (const key of Object.keys(sheetRenders)) delete sheetRenders[key];
  sent.length = 0;
  composer = undefined;
  suggestions = undefined;
});
afterEach(async () => {
  if (tree) await act(async () => tree?.unmount());
  tree = undefined;
});

async function mount() {
  await act(async () => {
    tree = create(<SessionChatInput onSend={onSend} commands={commands} agents={[{ name: 'reviewer', mode: 'primary', permission: [], options: {} }, { name: 'builder', mode: 'primary', permission: [], options: {} }]} currentSessionId="s1" sandboxUrl="https://sandbox.test" />);
  });
}
async function type(text: string) {
  await act(async () => composer.onChangeText(text));
  expect(composer.value).toBe(text);
}

test('typing, "@", "#" and "/" do not re-render the memoized sheets', async () => {
  await mount();
  const mounted = { ...sheetRenders };
  expect(Object.keys(mounted).sort()).toEqual(['AttachSheet', 'AutoContinueSheet', 'ModelPickerSheet', 'SessionFilesSheet']);

  for (const text of ['h', 'he', 'hello', 'hello @', 'hello @ag', 'hello #', 'hello #rev', '/', '/re', '']) await type(text);
  expect(sheetRenders).toEqual(mounted);
});

test('Recent files appends to the text as typed, and Send sends the text as typed', async () => {
  await mount();
  await type('look at');
  await act(async () => sheetProps.SessionFilesSheet.onSelect({ path: '/workspace/notes.md' }));
  expect(composer.value.startsWith('look at')).toBe(true);
  expect(composer.value).toContain('notes.md');

  await type('hello world');
  await act(async () => composer.onSubmit());
  expect(sent).toHaveLength(1);
  expect(sent[0][0]).toBe('hello world');
  expect(composer.value).toBe('');
});

for (const trigger of ['@', '#']) {
  test(`${trigger} suggestions follow the caret before trailing text and close elsewhere`, async () => {
    await mount();
    await type(`hello ${trigger} trailing`);
    await act(async () => composer.onSelectionChange({ nativeEvent: { selection: { start: 7, end: 7 } } }));
    expect(suggestions?.items.map((item) => item.label)).toEqual(trigger === '@' ? ['reviewer', 'builder'] : ['review', 'build']);
    await type(`hello ${trigger}rev trailing`);
    await act(async () => composer.onSelectionChange({ nativeEvent: { selection: { start: 10, end: 10 } } }));
    expect(suggestions?.items.map((item) => item.label)).toEqual([trigger === '@' ? 'reviewer' : 'review']);
    expect(suggestions?.items[0].kind).toBe(trigger === '@' ? 'agent' : 'skill');
    await act(async () => composer.onSelectionChange({ nativeEvent: { selection: { start: 15, end: 15 } } }));
    expect(tree?.root.findAllByType(moduleMocks['./MentionSuggestions'].MentionSuggestions)).toHaveLength(0);
  });

  test(`${trigger} suggestions keep end-of-text typing behavior`, async () => {
    await mount();
    await type(`hello ${trigger}rev`);
    await act(async () => composer.onSelectionChange({ nativeEvent: { selection: { start: 10, end: 10 } } }));
    expect(suggestions?.items.map((item) => item.label)).toEqual([trigger === '@' ? 'reviewer' : 'review']);
  });
}
