import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { TestUiHost } from '../../test-utils/ui-host';
import { IntlTestProvider } from '../../test-utils/intl';

let pathname = '/projects/example/customize/reminders';
let settled = true;
let reminders = false;
let tabs = ['agent', 'triggers'];
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
const replace = mock(() => {});
mock.module('../../internal/layout/project-settings-nav', () => ({
  useCapabilityAccess: () => ({ settled, tabs }),
}));
mock.module('@kortix/sdk/react', () => ({
  useFeatureFlag: () => ({ enabled: reminders, isLoading: false }),
}));
const { CapabilityAccessGate } = await import('./capability-access-gate');
let mounted: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => mounted?.unmount());
  mounted = undefined;
  replace.mockClear();
  pathname = '/projects/example/customize/reminders';
  settled = true;
  reminders = false;
  tabs = ['agent', 'triggers'];
});
function render() {
  act(() => {
    mounted = create(
      <IntlTestProvider>
        <TestUiHost params={{ id: 'example' }} pathname={pathname}
          router={{ replace, push() {}, prefetch() {}, back() {} }}>
          <CapabilityAccessGate projectId="example"><p>Reminder inventory</p></CapabilityAccessGate>
        </TestUiHost>
      </IntlTestProvider>,
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
    pathname = '/projects/example/customize/secrets';
    render();
    expect(replace).toHaveBeenCalledWith('/projects/example/customize/agents');
  });
});
