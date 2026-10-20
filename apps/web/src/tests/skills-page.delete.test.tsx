import { beforeEach, expect, mock, test } from 'bun:test';
import { createElement, Fragment, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
notifyManager.setScheduler((callback) => queueMicrotask(callback));
const sdk = await import('@kortix/sdk');
const sdkReact = await import('@kortix/sdk/react');
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
let allowed = true;
let failure = false;
let deleted: string[] = [];
let errors: string[] = [];
let reads = 0;
const skills = [
  { name: 'Release Notes', path: 'skills/release/SKILL.md', description: '' },
  { name: 'kortix-ui', path: 'skills/kortix-ui/SKILL.md', description: '' },
];
mock.module('@kortix/sdk', () => ({ ...sdk,
  getProjectDetail: async () => { reads++; return { config: { skills: skills.filter(s => !deleted.includes(s.name)) } }; },
  deleteProjectSkill: async (_id: string, name: string) => {
    if (failure) throw new Error('Repository changed');
    deleted.push(name); return { ok: true };
  },
}));
mock.module('@kortix/sdk/react', () => ({ ...sdkReact, useProjectAccountId: () => 'account-test' }));
mock.module('../../../../packages/ui/src/internal/lib/use-project-can', () => ({ useProjectCan: () => ({ allowed }) }));
mock.module('../../../../packages/ui/src/internal/hooks', () => ({ useSlashFocus: () => {} }));
mock.module('../../../../packages/ui/src/customize/use-configure-thread', () => ({ useConfigureThread: () => ({}), newConfigPrompt: () => '' }));
mock.module('../../../../packages/ui/src/primitives/toast', () => ({ successToast: () => {}, errorToast: (message: string) => errors.push(message) }));
function Pass({ children }: { children?: ReactNode }) { return createElement(Fragment, null, children); }
mock.module('../../../../packages/ui/src/customize/shared/capability-page-shell', () => ({ CapabilityPageShell: Pass }));
mock.module('../../../../packages/ui/src/customize/shared/catalog/catalog-grid', () => ({ CatalogGrid: Pass }));
mock.module('../../../../packages/ui/src/customize/shared/catalog/catalog-card', () => ({ CatalogCard: ({ title, onClick }: { title: string; onClick: () => void }) => createElement('button', { onClick }, title) }));
mock.module('../../../../packages/ui/src/customize/shared/entity/entity-modal', () => ({ EntityDetailModal: ({ open, aside }: { open: boolean; aside: ReactNode }) => open ? aside : null }));
mock.module('../../../../packages/ui/src/customize/skills/new-skill-modal', () => ({ NewSkillModal: () => null }));
mock.module('../../../../packages/ui/src/primitives/confirm-dialog', () => ({ ConfirmDialog: ({ open, onConfirm, onOpenChange, confirmDisabled }: { open: boolean; onConfirm: () => void; onOpenChange: (open: boolean) => void; confirmDisabled: boolean }) => open ? createElement(Fragment, null,
  createElement('button', { onClick: onConfirm, disabled: confirmDisabled }, 'Confirm deletion'),
  createElement('button', { onClick: () => onOpenChange(false) }, 'Cancel deletion')) : null }));
const { SkillsPage } = await import('../../../../packages/ui/src/customize/skills/skills-page');
beforeEach(() => { allowed = true; failure = false; deleted = []; errors = []; reads = 0; });
async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<QueryClientProvider client={client}><SkillsPage projectId="project-test" /></QueryClientProvider>); });
  await act(async () => { await client.refetchQueries(); });
  return tree;
}
async function click(tree: ReactTestRenderer, label: string) {
  const button = tree.root.findAllByType('button').find(b => b.children.join('') === label);
  expect(button).toBeDefined();
  await act(async () => { button?.props.onClick(); });
}
function deleteButtons(tree: ReactTestRenderer) { return tree.root.findAllByType('button').filter(b => b.children.join('') === 'Delete skill'); }
test('confirmation precedes exact-name deletion and refreshes the catalog', async () => {
  const tree = await mount();
  await click(tree, 'Release Notes'); await click(tree, 'Delete skill');
  expect(deleted).toEqual([]);
  await click(tree, 'Cancel deletion'); expect(deleted).toEqual([]);
  await click(tree, 'Delete skill'); const before = reads;
  await click(tree, 'Confirm deletion');
  expect(deleted).toEqual(['Release Notes']); expect(reads).toBeGreaterThan(before);
  await act(async () => tree.unmount());
});
test('readers and platform-managed skills have no delete action', async () => {
  allowed = false; let tree = await mount(); await click(tree, 'Release Notes');
  expect(deleteButtons(tree)).toHaveLength(0); await act(async () => tree.unmount());
  allowed = true; tree = await mount(); await click(tree, 'kortix-ui');
  expect(deleteButtons(tree)).toHaveLength(0); await act(async () => tree.unmount());
});
test('failed deletion reports the error and leaves confirmation available', async () => {
  failure = true; const tree = await mount();
  await click(tree, 'Release Notes'); await click(tree, 'Delete skill'); await click(tree, 'Confirm deletion');
  expect(errors).toEqual(['Repository changed']); expect(deleted).toEqual([]);
  expect(tree.root.findAllByType('button').some(b => b.children.join('') === 'Confirm deletion')).toBe(true);
  await act(async () => tree.unmount());
});
