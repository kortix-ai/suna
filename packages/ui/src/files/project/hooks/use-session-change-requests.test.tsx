import { afterAll, expect, test } from 'bun:test';
import { configureKortix } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create } from 'react-test-renderer';
import { ProjectFilesProvider } from '../context';
import { useSessionChangeRequests } from './use-change-requests';

const urls: string[] = [];
configureKortix({ backendUrl: 'http://api.example.test/v1', getToken: async () => 'synthetic',
  fetch: async (input) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    return Response.json(url.searchParams.has('cursor')
      ? { change_requests: [{ cr_id: 'second' }], next_cursor: null }
      : { change_requests: [{ cr_id: 'first' }], next_cursor: 'next-page' });
  },
});
afterAll(() => configureKortix({ backendUrl: '', getToken: async () => null }));

function Read({ enabled }: { enabled: boolean }) {
  const { data } = useSessionChangeRequests('session_test', { enabled });
  return <span>{data?.change_requests.map((cr) => cr.cr_id).join(',')}</span>;
}

test('session query follows every page while retaining the server-side session filter', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(<QueryClientProvider client={client}><ProjectFilesProvider value={{ projectId: 'project_test', ref: 'dev' }}><Read enabled /></ProjectFilesProvider></QueryClientProvider>);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(urls).toHaveLength(2);
  expect(urls.every((url) => new URL(url).searchParams.get('origin_session_id') === 'session_test')).toBe(true);
  expect(new URL(urls[1]).searchParams.get('cursor')).toBe('next-page');
  expect(renderer?.toJSON()).toMatchObject({ children: ['first,second'] });
  await act(async () => renderer?.unmount());
  client.clear();
});

test('a denied read issues no request', async () => {
  urls.length = 0;
  const client = new QueryClient();
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(<QueryClientProvider client={client}><ProjectFilesProvider value={{ projectId: 'project_test', ref: 'dev' }}><Read enabled={false} /></ProjectFilesProvider></QueryClientProvider>);
  });
  expect(urls).toHaveLength(0);
  await act(async () => renderer?.unmount());
  client.clear();
});
