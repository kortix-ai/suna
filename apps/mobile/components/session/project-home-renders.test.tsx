/**
 * Project home: a keystroke re-renders the composer card only. The hero (a
 * Skia canvas), the three sheets and the rest of the screen stay as they were,
 * because the draft lives in `HomeComposer`. Send still sends the text as
 * typed, once per tap burst. The drawer's New session focuses the composer
 * once home is the screen on top.
 */
import { afterEach, beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { markComposerFocus } from '@/lib/onboarding/composer-handoff';

(globalThis as any).__DEV__ = true;
(globalThis as any).requestAnimationFrame ??= (callback: () => void) => setTimeout(callback, 0);
(globalThis as any).cancelAnimationFrame ??= (id: ReturnType<typeof setTimeout>) => clearTimeout(id);

const source = readFileSync(import.meta.dir + '/ProjectHome.tsx', 'utf8');
const Empty = () => null;
const renders: Record<string, number> = {};
const counted = (name: string) =>
  React.forwardRef((_props: any, _ref) => {
    renders[name] = (renders[name] ?? 0) + 1;
    return null;
  });
const Pass = ({ children }: any) => children ?? null;
let composer: any;
let composerRenders = 0;
const submitted: any[] = [];
const NO_FILES: any[] = [];
const attachments = { files: NO_FILES, uploads: {}, add() {}, remove() {}, takeForSend: async () => ({ files: [], fileParts: [] }), clearAfterSend() {}, reclaim() {} };
const toast = { error() {} };
const models = { gatewayEnabled: false, providers: undefined, models: [], modelDefaults: undefined, isLoading: false, refetchModelCount() {} };
let screenFocused = true;
const store = { selectedAgent: null, setAgent() {}, globalDefault: null, agentModels: {}, setModelForAgent() {}, modelVariants: {}, setVariant() {} };

const moduleMocks: Record<string, Record<string, any>> = {
  'react-native': { View: Pass, Pressable: Empty, Keyboard: { dismiss() {} } },
  'react-native-keyboard-controller': { KeyboardAvoidingView: Pass, useReanimatedKeyboardAnimation: () => ({ progress: { value: 0 } }) },
  'react-native-reanimated': { default: { View: Pass }, useAnimatedStyle: () => ({}) },
  'expo-router': { useIsFocused: () => screenFocused },
  'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
  '@/components/kortix/composer': {
    Composer: (props: any) => {
      composerRenders++;
      composer = props;
      return null;
    },
  },
  '@/components/kortix/toast-provider': { useToast: () => toast },
  '@/components/session/FloatingMenuButton': { FloatingMenuButton: counted('FloatingMenuButton') },
  '@/components/session/ConnectProviderSheet': { ConnectProviderSheet: counted('ConnectProviderSheet') },
  '@/components/session/ModelPickerSheet': { ModelPickerSheet: counted('ModelPickerSheet') },
  '@/components/session/ProjectHero': { ProjectHero: counted('ProjectHero') },
  '@/components/session/AttachSheet': { AttachSheet: counted('AttachSheet') },
  '@/components/session/useComposerAttachments': { useComposerAttachments: () => attachments },
  '@/components/session/useRecoverPendingPick': { useRecoverPendingPick() {} },
  '@/lib/projects/hooks': { useComposerModels: () => models, useProjectDetail: () => ({ data: undefined }) },
  '@/lib/session/use-composer-draft': { useComposerDraft() {} },
  '@/lib/session/local-config': { useLocalConfigStore: (selector: any) => selector(store) },
};
// Pure logic stays real: what the screen resolves and decides on Send.
const KEEP_REAL = new Set([
  'react',
  '@kortix/sdk',
  '@kortix/shared',
  '@/lib/session/composer-draft',
  '@/lib/session/composer-model',
  '@/lib/session/send-plan',
  '@/lib/session/composer-config',
  '@/lib/session/model-picker',
  '@/lib/session/composer-uploads',
  '@/components/session/use-pasted-tiles',
  '@/lib/onboarding/composer-handoff',
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

let ProjectHome: typeof import('./ProjectHome').ProjectHome;
let tree: ReactTestRenderer | undefined;
const onSubmitNewSession = async (input: any) => {
  submitted.push(input);
  return true;
};
const onOpenDrawer = () => {};

beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  ({ ProjectHome } = await import('./ProjectHome'));
});
beforeEach(() => {
  for (const key of Object.keys(renders)) delete renders[key];
  composerRenders = 0;
  submitted.length = 0;
  screenFocused = true;
});
afterEach(async () => {
  if (tree) await act(async () => tree?.unmount());
  tree = undefined;
});

const home = (takeInitialDraft?: () => { text: string; files: any[] }, sending = false) => (
  <ProjectHome
    projectId="project-1"
    sending={sending}
    onSubmitNewSession={onSubmitNewSession}
    onOpenDrawer={onOpenDrawer}
    takeInitialDraft={takeInitialDraft}
  />
);

async function mount(takeInitialDraft?: () => { text: string; files: any[] }) {
  await act(async () => {
    tree = create(home(takeInitialDraft));
  });
}

test('a keystroke re-renders the composer only: not the hero, the sheets or the menu button', async () => {
  await mount();
  const mounted = { ...renders };
  expect(Object.keys(mounted).sort()).toEqual(['AttachSheet', 'ConnectProviderSheet', 'FloatingMenuButton', 'ModelPickerSheet', 'ProjectHero']);
  const composerBefore = composerRenders;

  for (const text of ['h', 'he', 'hel', 'hello']) {
    await act(async () => composer.onChangeText(text));
    expect(composer.value).toBe(text);
  }
  expect(renders).toEqual(mounted);
  expect(composerRenders).toBe(composerBefore + 4);
});

test('Send sends the typed text once per tap burst; the draft stays', async () => {
  await mount();
  await act(async () => composer.onChangeText('  build a site  '));
  await act(async () => {
    void composer.onSubmit();
    void composer.onSubmit();
  });
  expect(submitted).toHaveLength(1);
  expect(submitted[0]).toMatchObject({ text: 'build a site', files: [], fileParts: [], agent: null });
  // Nothing is cleared on send: the parent remounts the screen once covered.
  expect(composer.value).toBe('  build a site  ');
});

test('a handed-back draft seeds the composer', async () => {
  await mount(() => ({ text: 'restored prompt', files: [] }));
  expect(composer.value).toBe('restored prompt');
});

test('a long paste becomes a tile, not text; Send carries it inline before the typed text', async () => {
  await mount();
  const paste = Array.from({ length: 12 }, (_, i) => `row ${i}`).join('\n');
  await act(async () => composer.onChangeText('see'));
  await act(async () => composer.onChangeText(`see${paste}`));
  expect(composer.value).toBe('see');
  expect(composer.pastes).toHaveLength(1);
  expect(composer.pastes[0].text).toBe(paste);
  const { id } = composer.pastes[0];

  await act(async () => composer.onSubmit());
  expect(submitted).toHaveLength(1);
  expect(submitted[0].text).toBe(`<pasted_content id="${id}" chars="${paste.length}">\n${paste}\n</pasted_content>\n\nsee`);
});

test('pastes alone send; a removed paste does not', async () => {
  await mount();
  const paste = 'p'.repeat(1000);
  await act(async () => composer.onChangeText(paste));
  expect(composer.value).toBe('');
  await act(async () => composer.onSubmit());
  expect(submitted).toHaveLength(1);
  expect(submitted[0].text).toContain(paste);

  await act(async () => composer.onRemovePaste(composer.pastes[0].id));
  expect(composer.pastes).toEqual([]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await act(async () => composer.onSubmit());
  expect(submitted).toHaveLength(1);
});

test('a handed-back prompt with a paste seeds the text and the tile', async () => {
  const paste = 'q'.repeat(1000);
  await mount(() => ({ text: `<pasted_content id="abcd1234" chars="1000">\n${paste}\n</pasted_content>\n\nhello`, files: [] }));
  expect(composer.value).toBe('hello');
  expect(composer.pastes).toEqual([{ id: 'abcd1234', text: paste }]);
});

/**
 * Points the composer's `inputRef` at a fake field that counts focus calls.
 * The first `drop` calls are dropped, as the OS does mid-transition.
 */
function trackFocus(drop = 0) {
  const field = {
    calls: 0,
    has: false,
    focus() {
      field.calls++;
      if (field.calls > drop) field.has = true;
    },
    isFocused: () => field.has,
  };
  const ref = composer.inputRef;
  if (typeof ref === 'function') ref(field);
  else ref.current = field;
  return field;
}

/** Past the last focus retry (`COMPOSER_FOCUS_RETRY_MS`). */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 750)); });

test('New session on a mounted home focuses the composer once', async () => {
  await mount();
  const field = trackFocus();
  await act(async () => markComposerFocus('project-1'));
  await settle();
  expect(field.has).toBe(true);
  expect(field.calls).toBe(1);
});

test('a focus dropped mid-transition is retried until the field has it', async () => {
  await mount();
  const field = trackFocus(2);
  await act(async () => markComposerFocus('project-1'));
  await settle();
  expect(field.has).toBe(true);
  expect(field.calls).toBe(3);
});

test('New session while home is covered focuses only once home is on top', async () => {
  screenFocused = false;
  await mount();
  const field = trackFocus();
  await act(async () => markComposerFocus('project-1'));
  await settle();
  expect(field.calls).toBe(0);
  // Home becomes the screen on top: the stack's focus event re-renders it.
  screenFocused = true;
  await act(async () => tree?.update(home(undefined, true)));
  await settle();
  expect(field.calls).toBe(1);
});

test("another project's New session does not focus this home", async () => {
  await mount();
  const field = trackFocus();
  await act(async () => markComposerFocus('project-2'));
  await settle();
  expect(field.calls).toBe(0);
});
