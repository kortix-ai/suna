import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create } from 'react-test-renderer';
import { readFileSync } from 'node:fs';

// The Review page's + ("Open a change request", KRTX-1720): it shows only for
// a viewer who holds project.write + project.gitops.push, the leaves
// `POST /change-requests` asserts. A built-in member used to see it, and the
// API refused the request. The sheet's verdicts are covered by
// `review/review-detail-sheet-permissions.test.tsx`.
// Real: the page, the SDK leaf catalog, the review rules. Every other import is
// a stub.

const source = readFileSync(`${import.meta.dir}/ReviewPage.tsx`, 'utf8');
const host = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);
const Empty = () => null;

type Can = { allowed: boolean; reason: string | null; isLoading: boolean; isError: boolean };
const can = (allowed: boolean, isLoading = false): Can => ({ allowed, reason: null, isLoading, isError: false });
let cans: Record<string, Can> = {};
const probes: Array<{ target: unknown; actions: readonly string[] }> = [];
let header: any;
const empty = { data: [], isLoading: false, isError: false, error: null, refetch: async () => {} };

const fakes: Record<string, Record<string, unknown>> = {
  'react-native': {
    View: host('View'),
    ScrollView: host('ScrollView'),
    RefreshControl: Empty,
    useWindowDimensions: () => ({ width: 400, height: 800 }),
  },
  nativewind: { useColorScheme: () => ({ colorScheme: 'light' }) },
  'react-i18next': { useTranslation: () => ({ t: (key: string) => key }) },
  'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
  '@tanstack/react-query': { useQueryClient: () => ({ invalidateQueries() {} }) },
  '@kortix/sdk/react': {
    useCans: (target: unknown, actions: readonly string[]) => {
      probes.push({ target, actions });
      return Object.fromEntries(actions.map((action) => [action, cans[action] ?? can(false, true)]));
    },
  },
  '@/components/kortix/page-header': {
    PageHeader: (props: any) => {
      header = props;
      return null;
    },
  },
  '@/components/kortix/pinned-bar': { PinnedBar: Empty, usePinnedBarInset: () => 0 },
  '@/components/kortix/toast-provider': { useToast: () => ({ error() {}, success() {} }) },
  '@/lib/projects/hooks': { useProjectBranches: () => empty, useProjectSessions: () => empty },
  '@/lib/review/use-review': { reviewKeys: { list: () => ['review'] }, useReviewItems: () => empty },
  '@/lib/utils/theme': { THEME: { light: { background: 'b' }, dark: { background: 'b' }, accent: {} } },
};
const real = new Set(['react', '@kortix/sdk', '@/lib/review/review-verdict', '@/lib/review/review-meta']);
const stubs: Record<string, Record<string, unknown>> = {};
for (const [, names, name] of source.matchAll(/import\s+(?:type\s+)?(?:\w+\s*,\s*)?\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gs)) {
  if (real.has(name)) continue;
  const values = (stubs[name] ??= { ...fakes[name] });
  for (const item of names.split(',')) {
    const key = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
    if (key && !(key in values)) values[key] = Empty;
  }
}
for (const [name, values] of Object.entries(stubs)) mock.module(name, () => values);

let ReviewPage: typeof import('./ReviewPage').ReviewPage;
beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  ReviewPage = (await import('./ReviewPage')).ReviewPage;
});

let tree: any;
function renderAs(next: Record<string, Can>) {
  cans = next;
  header = undefined;
  act(() => {
    tree = create(<ReviewPage page={{ id: 'page:review', label: 'Review' } as never} projectId="proj-1" onOpenSession={() => {}} />);
  });
}
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  probes.length = 0;
});

const allow = (...leaves: string[]) => Object.fromEntries(leaves.map((leaf) => [leaf, can(true)]));

describe('the Review page +', () => {
  test('probes the review leaves on this project', () => {
    renderAs({});
    expect(probes[0]).toEqual({
      target: { projectId: 'proj-1' },
      actions: ['project.write', 'project.gitops.push', 'project.gitops.merge', 'project.review.act'],
    });
  });

  test('a manager gets +', () => {
    renderAs(allow('project.write', 'project.gitops.push', 'project.gitops.merge', 'project.review.act'));
    expect(typeof header.onAdd).toBe('function');
    expect(header.addLabel).toBe('Open a change request');
  });

  test('a built-in member gets no +', () => {
    renderAs({ 'project.write': can(false), 'project.gitops.push': can(false) });
    expect(header.onAdd).toBeUndefined();
  });

  test('a custom role with review.act but without gitops.push gets no +', () => {
    renderAs(allow('project.write', 'project.review.act'));
    expect(header.onAdd).toBeUndefined();
  });

  test('while the probe is unresolved there is no + (fail closed)', () => {
    renderAs({});
    expect(header.onAdd).toBeUndefined();
  });
});
