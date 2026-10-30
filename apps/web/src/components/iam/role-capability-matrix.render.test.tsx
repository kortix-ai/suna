import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import type { Permission } from '@/lib/iam-client';
import { RoleCapabilityMatrix } from './role-capability-matrix';

const permissions: Permission[] = [
  { action: 'project.artifact.read', scope_type: 'project', resource_type: 'project', delegable: true, description: 'Read Artifacts', area: 'artifacts', level: 'view', implies: [] },
  { action: 'project.artifact.comment', scope_type: 'project', resource_type: 'project', delegable: true, description: 'Comment on Artifacts', area: 'artifacts', level: 'edit', implies: ['project.artifact.read'] },
  { action: 'project.artifact.write', scope_type: 'project', resource_type: 'project', delegable: true, description: 'Edit Artifacts', area: 'artifacts', level: 'edit', implies: ['project.artifact.read'] },
];

test('Comment is a visible independent control and emits only comment plus read', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  let selected = new Set<string>();
  let tree: ReturnType<typeof create> | undefined;
  try {
    const element = <RoleCapabilityMatrix scope="project" permissions={permissions} selected={selected} onChange={(next) => { selected = next; }} />;
    await act(async () => { tree = create(element); });
    if (!tree) throw new Error('Missing role matrix');
    expect(tree.root.findAllByType('span').some((node) => node.children.join('') === 'Comment')).toBe(true);
    expect(tree.root.findAllByProps({ 'aria-label': 'Comment on Artifacts' }).length).toBeGreaterThan(0);
    expect(tree.root.findAllByProps({ 'aria-label': 'Edit Artifacts' }).length).toBeGreaterThan(0);
    const comment = tree.root.findAllByProps({ 'aria-label': 'Comment on Artifacts' }).find((node) => typeof node.props.onCheckedChange === 'function');
    if (!comment) throw new Error('Missing Comment checkbox');
    await act(async () => { comment.props.onCheckedChange(true); });
    expect([...selected].sort()).toEqual(['project.artifact.comment', 'project.artifact.read']);
  } finally {
    if (tree) await act(async () => { tree!.unmount(); });
    if (original) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', original);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
});

test('an account role without comments keeps its two existing columns', () => {
  const html = renderToStaticMarkup(<RoleCapabilityMatrix scope="account" permissions={permissions} selected={new Set()} onChange={() => {}} />);
  expect(html).not.toContain('>Comment</span>');
  expect(html).not.toContain('Comment on Artifacts');
});
