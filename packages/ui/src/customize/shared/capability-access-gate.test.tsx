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
describe('bookmarked Reminders tab', () => {
  test('flag-off projects show an honest gate instead of silently replacing the URL with Agents', () => {
    const output = render();
    expect(output).toContain('is off for this project');
    expect(output).not.toContain('Reminder inventory');
    expect(replace).not.toHaveBeenCalled();
  });
  test('waits for access to settle before showing a gate', () => {
    settled = false;
    expect(render()).not.toContain('is off for this project');
    expect(replace).not.toHaveBeenCalled();
  });
  test('enabled and authorized projects still render the reminders inventory', () => {
    reminders = true;
    tabs.push('reminders');
    expect(render()).toContain('Reminder inventory');
    expect(replace).not.toHaveBeenCalled();
  });
  test('permission denial with the flag enabled keeps the shared access fallback', () => {
    reminders = true;
    expect(render()).not.toContain('Reminder inventory');
    expect(replace).toHaveBeenCalledWith('/projects/example/customize/agents');
  });
  test('other denied tabs keep the shared access fallback', () => {
    pathname = '/projects/example/admin/secrets';
    render();
    expect(replace).toHaveBeenCalledWith('/projects/example/customize/agents');
  });
});
