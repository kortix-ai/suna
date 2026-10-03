/**
 * Project home: a keystroke re-renders the composer card only. The hero (a
 * Skia canvas), the three sheets and the rest of the screen stay as they were,
 * because the draft lives in `HomeComposer`. Send still sends the text as
 * typed, once per tap burst.
 */
import { afterEach, beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as any).__DEV__ = true;
(globalThis as any).requestAnimationFrame ??= (callback: () => void) => setTimeout(callback, 0);

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
const store = { selectedAgent: null, setAgent() {}, globalDefault: null, agentModels: {}, setModelForAgent() {}, modelVariants: {}, setVariant() {} };

const moduleMocks: Record<string, Record<string, any>> = {
  'react-native': { View: Pass, Pressable: Empty, Keyboard: { dismiss() {} } },
  'react-native-keyboard-controller': { KeyboardAvoidingView: Pass, useReanimatedKeyboardAnimation: () => ({ progress: { value: 0 } }) },
  'react-native-reanimated': { default: { View: Pass }, useAnimatedStyle: () => ({}) },
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
  '@/lib/onboarding/composer-handoff': { takeComposerFocus: () => false },
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
});
afterEach(async () => {
  if (tree) await act(async () => tree?.unmount());
  tree = undefined;
});

async function mount(takeInitialDraft?: () => { text: string; files: any[] }) {
  await act(async () => {
    tree = create(
      <ProjectHome
        projectId="project-1"
        onSubmitNewSession={onSubmitNewSession}
        onOpenDrawer={onOpenDrawer}
        takeInitialDraft={takeInitialDraft}
      />,
    );
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
