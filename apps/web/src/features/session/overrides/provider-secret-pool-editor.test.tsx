import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { qk } from '@kortix/sdk/react';
import { renderToStaticMarkup } from 'react-dom/server';
import messages from '../../../../translations/en.json';
import { NewProviderSecretPoolEditor, ProviderSecretPoolEditor } from './provider-secret-pool-editor';

function render(input: {
  resources?: unknown[]; failed?: boolean; selection?: Record<string, string[]>; canEdit?: boolean; saving?: boolean;
  session?: { visibility: 'private' | 'project' | 'restricted'; created_by: string };
  /** Seed no configured pool, so the provider shows its default. */
  providerId?: string;
} = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (input.session) client.setQueryData(qk.project.session('project', 'session'), { session_id: 'session', ...input.session });
  client.setQueryData(['provider-pool-project', 'project'], { project: { account_id: 'account' } });
  client.setQueryData(['account-secret-resources', 'account', 'project'], { secrets: input.resources ?? [] });
  const listKey = ['session-provider-secret-pools', 'project', 'session'];
  const singleKey = ['session-provider-secret-pool', 'project', 'session', 'anthropic'];
  const pool = { provider_id: 'anthropic', configured: true, secret_ids: [] };
  // The list holds configured pools only: a provider with no selection has no entry.
  client.setQueryData(listKey, { pools: input.providerId ? [] : [pool], can_edit: input.canEdit ?? true });
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

describe('a session offers only keys it can use when it runs', () => {
  const team = { ...key('Team key'), access_mode: 'project', granted_user_ids: [] };
  const mine = { ...key('My key'), access_mode: 'members', granted_user_ids: ['me'] };

  test('a shared session hides keys granted to one member, and says why', () => {
    const html = render({ resources: [team, mine], session: { visibility: 'project', created_by: 'me' } });
    expect(html).toContain('Team key');
    expect(html).not.toContain('My key');
    expect(html).toContain('This session is shared with the project, so only keys shared with the whole project work here.');
  });

  test('a private session offers its creator`s own keys too, without the note', () => {
    const html = render({ resources: [team, mine], session: { visibility: 'private', created_by: 'me' } });
    expect(html).toContain('Team key');
    expect(html).toContain('My key');
    expect(html).not.toContain('This session is shared');
  });

  test('a shared session never promises the person`s own ChatGPT connection', () => {
    const chatgpt = { ...team, provider_id: 'codex', label: 'Team ChatGPT' };
    const shared = render({ resources: [chatgpt], session: { visibility: 'project', created_by: 'me' }, providerId: 'codex' });
    expect(shared).toContain('Using the project default');
    expect(shared).not.toContain('Using your default ChatGPT connection');
    const own = render({ resources: [chatgpt], session: { visibility: 'private', created_by: 'me' }, providerId: 'codex' });
    expect(own).toContain('Using your default ChatGPT connection');
  });
});
