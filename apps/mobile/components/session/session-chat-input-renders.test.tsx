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
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as any).__DEV__ = true;
(globalThis as any).requestAnimationFrame ??= (callback: () => void) => setTimeout(callback, 0);

const source = readFileSync(import.meta.dir + '/SessionChatInput.tsx', 'utf8');
const Empty = () => null;
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
const dispatched: any[] = [];
const pressables: any[] = [];
const NO_FILES: any[] = [];
const NO_UPLOADS = {};
const attachments = { files: NO_FILES, uploads: NO_UPLOADS, add() {}, remove() {}, takeForSend: async () => ({ files: [], fileParts: [] }), clearAfterSend() {}, reclaim() {} };
const NO_ALGORITHMS: any[] = [];
const toast = { error() {} };

const moduleMocks: Record<string, Record<string, any>> = {
  'react-native': { View: ({ children }: any) => children ?? null, Pressable: (props: any) => { pressables.push(props); return props.children ?? null; }, TextInput: Empty, StyleSheet: { create: (s: any) => s, hairlineWidth: 1 } },
  nativewind: { useColorScheme: () => ({ colorScheme: 'light' }) },
  '@/components/kortix/composer': { Composer: (props: any) => { composer = props; return props.header ?? null; }, COMPOSER_CONTROL_HIT_SLOP: 4 },
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
  // `useSlashCommands` renders these mention-list primitives in its slash menu.
  './MentionSuggestions': { SuggestionCard: Empty, SuggestionRow: Empty },
  // `useSlashCommands` imports these two directly; the original file no longer does.
  '@/lib/icons': { XIcon: Empty, TerminalIcon: Empty },
  // ...and this one in the staged-command chip (`SessionChatInput` no longer imports Text itself).
  '@/components/ui/text': { Text: Empty },
};
// Pure logic stays real: what typing and sending decide.
const KEEP_REAL = new Set([
  'react',
  './useMentions',
  './useSkillMentions',
  './useSlashCommands',
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
// `useSlashCommands` imports this directly; the original file no longer does.
mock.module('@/components/ui/text', () => ({ default: Empty, Text: Empty }));

let SessionChatInput: typeof import('./SessionChatInput').SessionChatInput;
let tree: ReactTestRenderer | undefined;
const onSend = (...args: any[]) => sent.push(args);
const commands = [{ name: 'review', description: 'Review', source: 'skill' }] as any[];

beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  ({ SessionChatInput } = await import('./SessionChatInput'));
});
beforeEach(() => {
  for (const key of Object.keys(sheetRenders)) delete sheetRenders[key];
  sent.length = 0;
  dispatched.length = 0;
  pressables.length = 0;
  composer = undefined;
});
afterEach(async () => {
  if (tree) await act(async () => tree?.unmount());
  tree = undefined;
});

async function mount() {
  await act(async () => {
    tree = create(
      <SessionChatInput
        onSend={onSend}
        onCommand={(...args: any[]) => dispatched.push(args)}
        commands={commands}
        currentSessionId="s1"
        sandboxUrl="https://sandbox.test"
      />,
    );
  });
}
async function type(text: string) {
  await act(async () => composer.onChangeText(text));
  expect(composer.value).toBe(text);
}
/** One Send tap, plus the frame that releases `submittingRef` for the next tap. */
async function send() {
  await act(async () => composer.onSubmit());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test('typing, "@", "#" and "/" do not re-render the memoized sheets', async () => {
  await mount();
  const mounted = { ...sheetRenders };
  expect(Object.keys(mounted).sort()).toEqual(['AttachSheet', 'AutoContinueSheet', 'ModelPickerSheet', 'SessionFilesSheet']);

  for (const text of ['h', 'he', 'hello', 'hello @', 'hello @ag', 'hello #', 'hello #rev', '/', '/re', '']) await type(text);
  expect(sheetRenders).toEqual(mounted);
});

test("'/rev' stages a command chip, X clears it, and Send dispatches the staged command", async () => {
  await mount();

  // "/rev" opens the slash menu with `review` in it; Send picks the highlighted one.
  await type('/rev');
  await send();
  expect(composer.value).toBe('');
  expect(composer.placeholder).toBe('Add details, then send');
  expect(composer.allowEmptySend).toBe(true);

  // X on the chip unstages: back to a plain composer with no chip pressable.
  expect(pressables).toHaveLength(1);
  expect(pressables[0].accessibilityLabel).toBe('Remove command review');
  await act(async () => pressables[0].onPress());
  expect(composer.placeholder).toBe('Ask anything');
  expect(composer.allowEmptySend).toBe(false);
  expect(pressables).toHaveLength(1); // no new pressable mounted

  // Re-stage, then Send dispatches the command instead of calling onSend.
  await type('/rev');
  await send();
  expect(composer.allowEmptySend).toBe(true);
  await send();
  expect(dispatched).toEqual([[commands[0], undefined]]);
  expect(sent).toEqual([]);
  expect(composer.value).toBe('');
  expect(composer.placeholder).toBe('Ask anything');
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
