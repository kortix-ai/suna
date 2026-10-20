import { expect, mock, test } from 'bun:test';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { createContext, useContext, useState, type ReactNode } from 'react';
import type { FlatModel } from '@kortix/sdk/react';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const setProjectDefault = mock(async () => {});
const setAccountDefault = mock(async () => {});
const setEnabled = mock(async () => {});
const resetToDefaults = mock(async () => {});
const writeText = mock(async () => {});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText } } });

const models = [
  ['deepseek-v4.1-flash', 'Managed default', true],
  ['example/available', 'Available model', true],
  ['example/hidden', 'Hidden model', false],
  ['example/blocked', 'Blocked model', false],
].map(([modelID, modelName, enabled]) => ({
  providerID: 'kortix', providerName: 'Kortix', modelID, modelName, enabled,
  contextWindow: 128000, capabilities: { vision: true, toolcall: true },
  cost: { input: 3, output: 9 },
})) as FlatModel[];
mock.module('@kortix/sdk/react', () => ({
  useProjectModels: () => models,
  useProjectModelPickerCatalog: () => ({ platformFeePercent: 5, managedPricingRoutes: {
    'deepseek-v4.1-flash': [{ route: 'synthetic', role: 'preferred', input: 2, output: 6, cacheRead: 1 }, { route: 'second', input: 4, output: 8, cacheRead: 0.5 }],
  } }),
  useModelEnablement: () => ({ defaultModel: 'deepseek-v4.1-flash', usingDefaults: false, resetToDefaults }),
  useModelAccess: () => ({ data: { enforced: true, disabledProviders: [], disabledModels: ['example/blocked'] }, defaultProvider: 'kortix', isLoading: false, isUpdating: false, setEnabled }),
  useModelDefaults: () => ({ accountDefault: { modelID: 'deepseek-v4.1-flash' }, isUpdating: false, setProjectDefault, setAccountDefault }),
  modelKeyToWire: ({ modelID }: { modelID: string }) => modelID,
  wireToModelKey: (modelID: string) => ({ providerID: 'kortix', modelID }),
}));
mock.module('@/features/providers/provider-connect', () => ({ ProviderLogoStatus: () => null }));
mock.module('@/hooks/utils', () => ({ useSlashFocus: () => {} }));
// Stateful UI-boundary stand-ins avoid portal/DOM machinery, not ModelsTab logic.
const Open = createContext({ open: false, toggle: () => {} });
function Surface({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <Open.Provider value={{ open, toggle: () => setOpen(!open) }}>{children}</Open.Provider>;
}
function Trigger({ children }: { children: ReactNode }) {
  const { toggle } = useContext(Open);
  return <button data-trigger onClick={toggle}>{children}</button>;
}
function Content({ children }: { children: ReactNode }) {
  return useContext(Open).open ? <div data-content>{children}</div> : null;
}
function Item({ children, disabled, onSelect }: { children: ReactNode; disabled?: boolean; onSelect?: () => void }) {
  return <button disabled={disabled} onClick={() => { if (!disabled) onSelect?.(); }}>{children}</button>;
}
mock.module('@/components/ui/dropdown-menu', () => ({ DropdownMenu: Surface, DropdownMenuTrigger: Trigger, DropdownMenuContent: Content, DropdownMenuItem: Item }));
mock.module('@/components/ui/hover-card', () => ({ HoverCard: Surface, HoverCardTrigger: Trigger, HoverCardContent: Content }));
mock.module('@/components/ui/hint', () => ({ default: ({ children }: { children: ReactNode }) => children }));
mock.module('@/components/ui/switch', () => ({ Switch: ({ checked, disabled, ...props }: { checked: boolean; disabled?: boolean }) => <button {...props} role="switch" aria-checked={checked} disabled={disabled} /> }));
mock.module('@/components/ui/input-group', () => ({
  InputGroupSearch: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  InputGroupSearchIcon: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  InputGroupSearchInput: (props: object) => <input {...props} />,
  InputGroupSearchClear: ({ onClick }: { onClick: () => void }) => <button onClick={onClick}>Clear search</button>,
}));
const { ModelsTab } = await import('./models-tab');


function text(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : text(child)).join('');
}
function button(root: ReactTestInstance, label: string) {
  return root.findAllByType('button').find((node) => text(node) === label)!;
}
async function click(node: ReactTestInstance) {
  expect(node).toBeDefined();
  await act(async () => node.props.onClick());
}
async function mount(canWrite = true) {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<ModelsTab projectId="synthetic-project" canWrite={canWrite} />); });
  return renderer;
}
function modelRow(root: ReactTestInstance, id: string) {
  return root.find((node) => node.type === 'div' && node.props['data-model-id'] === id);
}
function trigger(row: ReactTestInstance) {
  return row.findAllByType('button').find((node) => node.props['data-trigger'])!;
}

test('default scopes, hidden restrictions, wire clipboard and locked/read-only controls', async () => {
  const renderer = await mount();
  try {
    const root = renderer.root;
    const managed = modelRow(root, 'deepseek-v4.1-flash');
    expect(text(managed)).toContain('your default');
    expect(text(managed)).toContain('project default');
    expect(managed.findByProps({ role: 'switch' }).props.disabled).toBe(true);
    const available = modelRow(root, 'example/available');
    await click(trigger(available));
    await click(button(available, "Start this project's sessions with it"));
    await click(button(available, 'Make it my default everywhere'));
    expect(setProjectDefault).toHaveBeenCalledWith({ providerID: 'kortix', modelID: 'example/available' });
    expect(setAccountDefault).toHaveBeenCalledWith({ providerID: 'kortix', modelID: 'example/available' });
    await click(button(available, 'Copy model ID'));
    expect(writeText).toHaveBeenCalledWith('example/available');
    const hidden = modelRow(root, 'example/hidden');
    expect(text(hidden)).toContain('direct requests still work');
    await click(trigger(hidden));
    expect(button(hidden, "Start this project's sessions with it").props.disabled).toBe(true);
    expect(button(hidden, 'Make it my default everywhere').props.disabled).toBe(true);
    const disable = hidden.findAllByType('button').find((node) => /Disable/.test(text(node)))!;
    await click(disable);
    expect(setEnabled).toHaveBeenCalledWith({ target: 'model', id: 'example/hidden', enabled: false });
    const blocked = modelRow(root, 'example/blocked');
    expect(text(blocked)).toContain('Requests to this model are blocked');
    expect(blocked.findAllByProps({ 'data-trigger': true })).toHaveLength(0);
    await act(async () => renderer.update(<ModelsTab projectId="synthetic-project" />));
    expect(root.findAllByProps({ 'aria-label': 'Default settings for Available model' })).toHaveLength(0);
    expect(root.findAllByProps({ role: 'switch' }).every((node) => node.props.disabled)).toBe(true);
  } finally { await act(async () => renderer.unmount()); }
});

test('opens every managed price route including cached/preferred prices and data notes', async () => {
  const renderer = await mount();
  try {
    const managed = modelRow(renderer.root, 'deepseek-v4.1-flash');
    expect(text(managed)).toContain('from $2.00 / $6.00 per 1M');
    await click(trigger(managed));
    const routes = managed.findAll((node) => node.type === 'div' && node.props['data-pricing-route']);
    expect(routes.map((node) => node.props['data-pricing-route'])).toEqual(['synthetic', 'second']);
    expect(text(routes[0])).toContain('$1.00');
    expect(text(routes[0])).toContain('Preferred');
    expect(text(routes[1])).toContain('$0.50');
    expect(text(routes[1])).toContain('$4.00');
    expect(text(routes[1])).toContain('$8.00');
    expect(text(managed)).toContain('Zero data retention');
    expect(text(managed)).toContain('US');
  } finally { await act(async () => renderer.unmount()); }
});

test('owned search survives no-match and clear; Start over shares its row and resets', async () => {
  const renderer = await mount();
  try {
    const root = renderer.root;
    const input = root.findByType('input');
    const start = button(root, 'Start over');
    expect(start).toBeDefined();
    let searchRow = input.parent;
    while (searchRow && !(searchRow.type === 'div' && searchRow.findAllByType('button').includes(start))) searchRow = searchRow.parent;
    expect(searchRow?.type).toBe('div');
    expect(searchRow?.findAllByType('input')).toHaveLength(1);
    expect(searchRow?.findAll((node) => node.type === 'div' && node.props['data-model-id'])).toHaveLength(0);
    await click(start);
    expect(resetToDefaults).toHaveBeenCalledTimes(1);
    await act(async () => input.props.onChange({ target: { value: 'no-such-synthetic-model' } }));
    expect(root.findByType('input')).toBe(input);
    expect(input.props.value).toBe('no-such-synthetic-model');
    expect(root.findAll((node) => node.type === 'div' && node.props['data-model-id'])).toHaveLength(0);
    expect(text(root)).toContain('no-such-synthetic-model');
    await click(button(root, 'Clear search'));
    expect(input.props.value).toBe('');
    expect(root.findAll((node) => node.type === 'div' && node.props['data-model-id'])).toHaveLength(4);
  } finally { await act(async () => renderer.unmount()); }
});
