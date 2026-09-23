import { expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import messages from '../../../../translations/en.json';
import { NewProviderSecretPoolEditor, ProviderSecretPoolEditor } from './provider-secret-pool-editor';

function render(input: { resources?: unknown[]; failed?: boolean; selection?: Record<string, string[]>; canEdit?: boolean; saving?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['provider-pool-project', 'project'], { project: { account_id: 'account' } });
  client.setQueryData(['account-secret-resources', 'account', 'project'], { secrets: input.resources ?? [] });
  const listKey = ['session-provider-secret-pools', 'project', 'session'];
  const singleKey = ['session-provider-secret-pool', 'project', 'session', 'anthropic'];
  const pool = { provider_id: 'anthropic', configured: true, secret_ids: [] };
  client.setQueryData(listKey, { pools: [pool], can_edit: input.canEdit ?? true });
  client.setQueryData(singleKey, pool);
  if (input.failed) {
    for (const key of [listKey, singleKey]) {
      client.getQueryCache().find({ queryKey: key })!.setState({ status: 'error', error: new Error('offline') });
    }
  }
  const markup = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <QueryClientProvider client={client}>
        {input.selection
          ? <NewProviderSecretPoolEditor projectId="project" selection={input.selection} onChange={() => {}} />
          : <ProviderSecretPoolEditor projectId="project" sessionId="session" drafts={{}} onChange={() => {}} saving={input.saving} />}
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  client.clear();
  return markup;
}

const key = (id: string) => ({ secret_id: id, provider_id: 'anthropic', consumer: 'llm_gateway', can_use: true, active: true, label: id });

test('an empty configured pool remains recoverable after every resource is deleted', () => {
  const html = render();
  expect(html).toContain('Reset to project default');
  expect(html).toContain('This provider is disabled for this session.');
});

test('failed pool reads show recovery instead of an editable default', () => {
  const html = render({ resources: [key('Primary')], failed: true });
  expect(html).toContain('Keys could not be loaded.');
  expect(html).toContain('Try again');
  expect(html).not.toContain('Save key selection');
});

test('pre-create selection retains a provider whose grant disappeared', () => {
  const html = render({ selection: { anthropic: ['removed'] } });
  expect(html).toContain('Reset to project default');
  expect(html).toContain('1 selected key is unavailable');
});

test('the selection limit is visible before the API rejects an eleventh key', () => {
  const ids = Array.from({ length: 10 }, (_, index) => `key-${index}`);
  const html = render({ resources: [...ids, 'extra'].map(key), selection: { anthropic: ids } });
  expect(html).toContain('Maximum 10 keys per provider');
  expect(html).toMatch(/data-state="unchecked"[^>]*disabled/);
});

test('read-only viewers can switch providers while selection controls stay locked', () => {
  const html = render({ resources: [key('Primary'), { ...key('Other'), provider_id: 'openai' }], canEdit: false });
  const select = html.match(/<button[^>]*role="combobox"[^>]*>/)?.[0];
  expect(select).toBeDefined();
  expect(select).not.toContain('disabled=');
  expect(html).toMatch(/role="checkbox"[^>]*disabled/);
  expect(html).toContain('Only the session owner or a project manager');
  expect(html).not.toContain('Reset to project default');
});

test('saving prevents navigation away from the pending selection', () => {
  const html = render({ resources: [key('Primary')], saving: true });
  expect(html).not.toContain('href="/projects/project/customize/models"');
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Manage provider keys<\/button>/);
});
