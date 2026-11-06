import type { ProjectTrigger } from '@kortix/sdk';
import { afterEach, expect, jest, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { IntlTestProvider } from '../../../test-utils/intl';
import { TriggerList } from './trigger-list';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const MIN = 60_000;
const start = new Date('2026-10-17T10:00:00.000Z').getTime();
const trigger: ProjectTrigger = {
  slug: 'digest',
  path: 'kortix.yaml#triggers.digest',
  name: 'Digest',
  type: 'cron',
  agent: 'assistant',
  model: null,
  enabled: true,
  cron: '*/5 * * * *',
  run_at: null,
  webhook_url: null,
  timezone: 'UTC',
  secret_env: null,
  run: null,
  mode: null,
  interval_seconds: null,
  expect_event_within_seconds: null,
  event: null,
  prompt_template: 'Write the digest',
  session_mode: 'fresh',
  session_id: null,
  session_key: null,
  filter: null,
  session_access: { mode: 'private', memberIds: [], groupIds: [] },
  next_fire_at: new Date(start + 5 * MIN).toISOString(),
  last_fired_at: new Date(start - 2 * MIN).toISOString(),
};

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  jest.useRealTimers();
});

test('an idle list counts down on its own: no new data, no new props (KRTX-4380)', async () => {
  jest.useFakeTimers({ now: start });
  const list = <TriggerList triggers={[trigger]} selectedSlug={null} onOpen={() => {}} />;
  await act(async () => {
    renderer = create(<IntlTestProvider>{list}</IntlTestProvider>);
  });
  const text = () => JSON.stringify(renderer?.toJSON());
  expect(text()).toContain('next in 5 minutes');
  expect(text()).toContain('2m ago');
  await act(async () => { jest.advanceTimersByTime(2 * MIN); });
  expect(text()).toContain('next in 3 minutes');
  expect(text()).toContain('4m ago');
});
