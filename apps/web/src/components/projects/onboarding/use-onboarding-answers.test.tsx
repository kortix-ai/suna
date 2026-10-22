import { afterEach, expect, test } from 'bun:test';
import { configureKortix } from '@kortix/sdk';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useOnboardingAnswers } from './use-onboarding-answers';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  configureKortix({ backendUrl: '', getToken: async () => null });
});

test('survey saves keep their payload, stay stable, and do not block on a failed write', async () => {
  const requests: { url: string; method: string | undefined; body: unknown }[] = [];
  configureKortix({
    backendUrl: 'http://onboarding.test/v1',
    getToken: async () => 'synthetic-token',
    fetch: async (input, init) => {
      requests.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ message: 'unavailable' }), { status: 500 });
    },
  });
  let save: ReturnType<typeof useOnboardingAnswers>['save'] | undefined;
  function Survey({ projectId }: { projectId: string }) {
    save = useOnboardingAnswers(projectId).save;
    return null;
  }
  await act(async () => { renderer = create(createElement(Survey, { projectId: 'project-one' })); });
  const firstSave = save;
  await act(async () => { expect(save?.({ company_domain: 'example.test' })).toBeUndefined(); });
  await act(async () => { renderer?.update(createElement(Survey, { projectId: 'project-one' })); });
  expect(save).toBe(firstSave);
  expect(requests).toEqual([{
    url: 'http://onboarding.test/v1/projects/project-one/onboarding',
    method: 'PATCH',
    body: { profile: { company_domain: 'example.test' } },
  }]);
  await act(async () => { renderer?.update(createElement(Survey, { projectId: 'project-two' })); });
  expect(save).not.toBe(firstSave);
});
