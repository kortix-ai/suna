import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create } from 'react-test-renderer';
import { readFileSync } from 'node:fs';

// Schedules (KRTX-1720): each control follows the leaves its trigger route
// asserts, from one `useCans` probe read through the SDK's
// `triggerControlsFrom`. + on project.write + project.trigger.create, Fire now
// on project.trigger.fire, Pause/Resume and every edit on project.write +
// project.trigger.update, Delete on project.write + project.trigger.delete.
// Nothing shows while the probe is unresolved. The page used to render every control with no check: a member
// saw six controls and five answered 403.
// Real: the page, the SDK leaf catalog and mapping, the schedule formatting.
// Every other import is a stub.

const source = readFileSync(`${import.meta.dir}/SchedulesPage.tsx`, 'utf8') + readFileSync(`${import.meta.dir}/../schedules/ScheduleSheets.tsx`, 'utf8');
const host = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);
const Empty = () => null;

type Can = { allowed: boolean; reason: string | null; isLoading: boolean; isError: boolean };
const can = (allowed: boolean, isLoading = false): Can => ({ allowed, reason: null, isLoading, isError: false });
let cans: Record<string, Can> = {};
const probes: Array<{ target: unknown; actions: readonly string[] }> = [];
let header: any;
let rows: Array<{ label?: string; onPress?: () => void }> = [];
let prompt: any;
let pickers: any[] = [];

const TRIGGER = {
  slug: 'nightly-digest',
  name: 'Nightly digest',
  type: 'cron',
  cron: '0 0 3 * * *',
  timezone: 'UTC',
  run_at: null,
  enabled: true,
  agent: 'kortix',
  model: null,
  prompt_template: 'Summarize the day.',
  last_fired_at: null,
  path: 'kortix.yaml',
};
const mutation = { mutate() {}, isPending: false };

const fakes: Record<string, Record<string, unknown>> = {
  'react-native': { View: host('View'), Pressable: host('Pressable'), ScrollView: host('ScrollView') },
  nativewind: { useColorScheme: () => ({ colorScheme: 'light' }) },
  'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
  '@gorhom/bottom-sheet': { BottomSheetScrollView: host('SheetScroll'), BottomSheetTextInput: host('SheetInput') },
  '@kortix/sdk/react': {
    useCans: (target: unknown, actions: readonly string[]) => {
      probes.push({ target, actions });
      return Object.fromEntries(actions.map((action) => [action, cans[action] ?? can(false, true)]));
    },
  },
  '@/components/ui/text': { Text: host('Text') },
  '@/components/ui/button': { Button: host('Button') },
  '@/components/kortix/page-header': {
    PageHeader: (props: any) => {
      header = props;
      return null;
    },
  },
  '@/components/kortix/page-content': { PageContent: host('PageContent') },
  '@/components/kortix/page-list': {
    PageList: ({ data, renderItem }: any) => React.createElement('List', null, data.map((t: any, i: number) => renderItem(t, i))),
    StatusDot: Empty,
  },
  '@/components/kortix/pinned-bar': { PinnedBar: host('PinnedBar'), usePinnedBarInset: () => 0 },
  '@/components/kortix/settings-list': {
    SettingsGroup: host('Group'),
    SettingsGroupItem: host('GroupItem'),
    SettingsRow: (props: any) => {
      rows.push({ label: props.label, onPress: props.onPress });
      return null;
    },
  },
  '@/components/kortix/sheet': {
    KortixBottomSheetModal: host('Sheet'),
    SheetTitleRow: Empty,
    useSheetBackground: () => 'sheet',
  },
  '@/components/kortix/confirm-dialog': { useConfirmDialog: () => ({ confirm() {}, dialog: null }) },
  '@/components/kortix/toast-provider': { useToast: () => ({ error() {}, success() {} }) },
  '@/components/pages/TriggerAgentModelFields': {
    AgentPickerField: (props: any) => {
      pickers.push({ field: 'agent', ...props });
      return null;
    },
    ModelPickerField: (props: any) => {
      pickers.push({ field: 'model', ...props });
      return null;
    },
  },
  '@/components/pages/TriggerPromptField': {
    PromptPreview: (props: any) => {
      prompt = props;
      return null;
    },
    PromptEditView: Empty,
  },
  '@/lib/projects/hooks': {
    useProjectTriggers: () => ({ data: { triggers: [TRIGGER], errors: [] }, isLoading: false, isError: false, error: null, refetch() {} }),
    useCreateProjectTrigger: () => mutation,
    useUpdateProjectTrigger: () => mutation,
    useDeleteProjectTrigger: () => mutation,
    useFireProjectTrigger: () => mutation,
  },
  '@/lib/theme-colors': { useThemeColors: () => ({}) },
  '@/lib/utils/theme': {
    THEME: {
      light: { background: 'b', foreground: 'f', mutedForeground: 'm', destructive: 'd' },
      dark: { background: 'b', foreground: 'f', mutedForeground: 'm', destructive: 'd' },
      accent: { orange: 'o' },
    },
    withAlpha: (color: string) => color,
  },
  '@/lib/utils/mono-font': { MONO_FONT_FAMILY: 'mono' },
  '@/lib/haptics': { haptics: { tap() {}, success() {}, selection() {}, medium() {} } },
};
fakes['./TriggerAgentModelFields'] = fakes['@/components/pages/TriggerAgentModelFields'];
fakes['./TriggerPromptField'] = fakes['@/components/pages/TriggerPromptField'];
const real = new Set(['react', '@kortix/sdk', '@/lib/projects/triggers-format', '@/lib/projects/schedule-input', '@/components/schedules/ScheduleSheets']);
const stubs: Record<string, Record<string, unknown>> = {};
for (const [, names, name] of source.matchAll(/import\s+(?:type\s+)?(?:\w+\s*,\s*)?\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gs)) {
  if (real.has(name)) continue;
  const values = (stubs[name] ??= { ...fakes[name] });
  for (const item of names.split(',')) {
    const key = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
    if (key && !(key in values)) values[key] = Empty;
  }
}
stubs['react-native-reanimated'] = { default: { View: host('AnimatedView') } };
for (const [name, values] of Object.entries(stubs)) mock.module(name, () => values);

let SchedulesPage: typeof import('./SchedulesPage').SchedulesPage;
beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  SchedulesPage = (await import('./SchedulesPage')).SchedulesPage;
});

let tree: any;
/** Render the page for `next`, then open the schedule's detail sheet. */
function openAs(next: Record<string, Can>) {
  cans = next;
  rows = [];
  pickers = [];
  prompt = undefined;
  act(() => {
    tree = create(<SchedulesPage page={{ id: 'page:schedules', label: 'Schedules' }} projectId="proj-1" />);
  });
  act(() => rows.find((r) => r.label === TRIGGER.name)!.onPress!());
}
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  probes.length = 0;
});

/** The detail sheet's pinned bar: its button labels, by visible text or accessibility label. */
function barButtons(): string[] {
  const bars = tree.root.findAllByType('PinnedBar');
  if (bars.length === 0) return [];
  return bars[0].findAllByType('Button').map((button: any) => {
    if (button.props.accessibilityLabel) return button.props.accessibilityLabel;
    return button.findAllByType('Text').map((t: any) => String(t.props.children)).join('');
  });
}
const detailPickers = () => pickers.filter((p) => p.flush);

const WRITE = 'project.write';
const CREATE = 'project.trigger.create';
const FIRE = 'project.trigger.fire';
const UPDATE = 'project.trigger.update';
const DELETE = 'project.trigger.delete';

describe('Schedules controls', () => {
  test('one probe of the trigger leaves on this project', () => {
    openAs({});
    expect(probes.at(-1)).toEqual({
      target: { projectId: 'proj-1' },
      actions: [WRITE, CREATE, FIRE, UPDATE, DELETE],
    });
  });

  test('a manager gets +, Fire now, Pause, Delete and every editor', () => {
    openAs({ [WRITE]: can(true), [CREATE]: can(true), [FIRE]: can(true), [UPDATE]: can(true), [DELETE]: can(true) });
    expect(typeof header.onAdd).toBe('function');
    expect(barButtons()).toEqual(['Fire now', 'Pause schedule', 'Delete schedule']);
    expect(typeof prompt.onEdit).toBe('function');
    expect(detailPickers().map((p) => p.disabled)).toEqual([false, false]);
  });

  test('a built-in member (trigger.read + trigger.fire) gets Fire now and nothing else', () => {
    openAs({ [WRITE]: can(false), [CREATE]: can(false), [FIRE]: can(true), [UPDATE]: can(false), [DELETE]: can(false) });
    expect(header.onAdd).toBeUndefined();
    expect(barButtons()).toEqual(['Fire now']);
    expect(prompt.onEdit).toBeUndefined();
    expect(detailPickers().map((p) => p.disabled)).toEqual([true, true]);
  });

  test('a custom update-only role pauses and edits, with no +, no Fire now and no Delete', () => {
    openAs({ [WRITE]: can(true), [UPDATE]: can(true) });
    expect(header.onAdd).toBeUndefined();
    expect(barButtons()).toEqual(['Pause schedule']);
    expect(typeof prompt.onEdit).toBe('function');
    expect(detailPickers().map((p) => p.disabled)).toEqual([false, false]);
    // Pause takes Fire now's full-width slot.
    const pause = tree.root.findAllByType('PinnedBar')[0].findAllByType('Button')[0];
    expect(pause.props.className).toContain('flex-1');
  });

  test('trigger.update without project.write offers no Pause: the route loads the project for write', () => {
    openAs({ [UPDATE]: can(true), [FIRE]: can(true) });
    expect(barButtons()).toEqual(['Fire now']);
    expect(prompt.onEdit).toBeUndefined();
  });

  test('while the probe is unresolved, no control shows and no action bar draws (fail closed)', () => {
    openAs({});
    expect(header.onAdd).toBeUndefined();
    expect(tree.root.findAllByType('PinnedBar')).toHaveLength(0);
    expect(prompt.onEdit).toBeUndefined();
    expect(detailPickers().map((p) => p.disabled)).toEqual([true, true]);
  });
});

describe('Schedules sheet characterization', () => {
  test('create renders recurring presets, timezone, name and prompt fields before a schedule is selected', () => {
    cans = {};
    act(() => {
      tree = create(<SchedulesPage page={{ id: 'page:schedules', label: 'Schedules' }} projectId="proj-1" />);
    });
    const rendered = JSON.stringify(tree.toJSON());
    for (const label of ['Recurring', 'Run once', 'Custom cron', 'Timezone', 'Name', 'Prompt', 'Create schedule', 'Every 5 minutes', 'Every 15 minutes', 'Hourly', 'Daily at 9:00', 'Weekdays at 9:00', 'Mondays at 9:00']) {
      expect(rendered).toContain(label);
    }
    expect(rendered).toContain('Daily digest');
    expect(rendered).toContain('What should the agent do when this fires?');
    expect(tree.root.findAllByType('Button').at(-1).props.disabled).toBe(true);
  });

  test('detail renders the schedule rows, prompt and pinned actions', () => {
    openAs({ [WRITE]: can(true), [FIRE]: can(true), [UPDATE]: can(true), [DELETE]: can(true) });
    expect(rows.map((row) => row.label)).toEqual(expect.arrayContaining(['Runs', 'Cron', 'Time zone', 'Last fired', 'Source']));
    expect(prompt.value).toBe(TRIGGER.prompt_template);
    expect(barButtons()).toEqual(['Fire now', 'Pause schedule', 'Delete schedule']);
  });
});
