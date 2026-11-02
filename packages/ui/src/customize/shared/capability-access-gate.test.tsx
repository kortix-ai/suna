import { afterEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { TestUiHost } from '../../test-utils/ui-host';
import { IntlTestProvider } from '../../test-utils/intl';

let pathname = '/projects/example/admin/loops';
let settled = true;
let reminders = false;
let tabs = ['agent', 'triggers'];
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
const replace = mock(() => {});
mock.module('../../internal/layout/project-settings-nav', () => ({
  useCapabilityAccess: () => ({ settled, tabs }),
}));
const sdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...sdkReact,
  useFeatureFlag: () => ({ enabled: reminders, isLoading: false }),
}));
const { CapabilityAccessGate } = await import('./capability-access-gate');
let mounted: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => mounted?.unmount());
  mounted = undefined;
  replace.mockClear();
  pathname = '/projects/example/admin/loops';
  settled = true;
  reminders = false;
  tabs = ['agent', 'triggers'];
});
function render() {
  act(() => {
    mounted = create(
      <QueryClientProvider client={new QueryClient()}><IntlTestProvider>
        <TestUiHost params={{ id: 'example' }} pathname={pathname}
          router={{ replace, push() {}, prefetch() {}, back() {} }}>
          <CapabilityAccessGate projectId="example"><p>Reminder inventory</p></CapabilityAccessGate>
        </TestUiHost>
      </IntlTestProvider></QueryClientProvider>,
    );
  });
  return JSON.stringify(mounted?.toJSON());
}
// The Loops page and its `reminders` flag gate were removed on 2026-10-28: a
// bookmarked `/admin/loops` is the Triggers page, which Project admin gates
// on the Triggers rule (`project-admin-sections.ts`), not on this gate.
describe('bookmarked Loops address', () => {
  test('is not gated on the reminders flag any more', () => {
    expect(render()).toContain('Reminder inventory');
    expect(render()).not.toContain('is off for this project');
    expect(replace).not.toHaveBeenCalled();
  });
  test('other denied tabs keep the shared access fallback', () => {
    pathname = '/projects/example/admin/secrets';
    render();
    expect(replace).toHaveBeenCalledWith('/projects/example/customize/agents');
  });
});
