import { expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureKortix } from '../core/http/config';
import { useApproveCaptureDevice, useCaptureDeviceGrant, useDenyCaptureDevice } from './use-capture';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test('the approval page reads the grant, approves it into a project, and the grant read refreshes', async () => {
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const calls: string[] = [];
  let status = 'pending';
  globalThis.fetch = mock(async (url: unknown, options: RequestInit = {}) => {
    calls.push(`${options.method ?? 'GET'} ${String(url)}`);
    if (options.method === 'POST' && String(url).endsWith('/approve')) status = 'approved';
    return Response.json({ user_code: 'ABCD-1234', status, device: { name: 'Laptop' } });
  }) as unknown as typeof fetch;
  let grant: ReturnType<typeof useCaptureDeviceGrant>;
  let approve: ReturnType<typeof useApproveCaptureDevice>;
  let deny: ReturnType<typeof useDenyCaptureDevice>;
  function Probe() {
    grant = useCaptureDeviceGrant('ABCD-1234');
    approve = useApproveCaptureDevice();
    deny = useDenyCaptureDevice();
    return null;
  }
  await act(async () => {
    create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(grant!.data?.status).toBe('pending');
  await act(async () => {
    await approve!.mutateAsync({ userCode: 'ABCD-1234', projectId: 'p1' });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(calls).toContain('POST http://test.local/capture/device/grants/ABCD-1234/approve');
  expect(grant!.data?.status).toBe('approved');
  await act(async () => {
    await deny!.mutateAsync('ABCD-1234');
  });
  expect(calls).toContain('POST http://test.local/capture/device/grants/ABCD-1234/deny');
});

test('no user code, no request', async () => {
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const fetchMock = mock(async () => Response.json({}));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  function Probe() {
    useCaptureDeviceGrant(null);
    return null;
  }
  await act(async () => {
    create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(fetchMock.mock.calls.length).toBe(0);
});
