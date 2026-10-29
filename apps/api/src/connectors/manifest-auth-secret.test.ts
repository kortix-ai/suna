import { describe, expect, mock, test } from 'bun:test';

let manifest: { raw: Record<string, unknown> } = { raw: {} };
const commits: string[] = [];
mock.module('./manifest-mutation', () => ({
  mutateManifestWithRetry: async (_p: unknown, _op: string, mutate: (m: typeof manifest) => { ok: boolean; commitMessage?: string | null }) => {
    const draft = { raw: structuredClone(manifest.raw) };
    const change = mutate(draft);
    if (change.ok && change.commitMessage) { manifest = draft; commits.push(change.commitMessage); }
    return change.ok ? { ok: true } : change;
  },
}));
mock.module('../projects/surface', () => ({ withProjectGitAuth: async (row: unknown) => row }));
mock.module('../shared/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ projectId: 'p' }] }) }) }) },
}));
const { commitConnectorAuthSecret, withAuthSecret } = await import('./manifest-auth-secret');

describe('kortix.yaml owns connectors[].auth.secret', () => {
  test('withAuthSecret sets the secret, keeps the other auth keys, and drops an emptied auth', () => {
    expect(withAuthSecret({ slug: 'crm', auth: { type: 'bearer' } }, 'CRM_TOKEN')).toEqual({ slug: 'crm', auth: { type: 'bearer', secret: 'CRM_TOKEN' } });
    expect(withAuthSecret({ slug: 'crm', auth: { secret: 'OLD' } }, null)).toEqual({ slug: 'crm' });
  });

  test('binding commits to the declared entry; unbinding removes it; an undeclared connector commits nothing', async () => {
    manifest = { raw: { connectors: [{ slug: 'crm', provider: 'openapi', auth: { type: 'bearer' } }] } };
    expect(await commitConnectorAuthSecret('p', 'crm', 'CRM_TOKEN')).toEqual({ ok: true });
    expect((manifest.raw.connectors as Array<Record<string, unknown>>)[0]!.auth).toEqual({ type: 'bearer', secret: 'CRM_TOKEN' });
    expect(await commitConnectorAuthSecret('p', 'crm', null)).toEqual({ ok: true });
    expect((manifest.raw.connectors as Array<Record<string, unknown>>)[0]!.auth).toEqual({ type: 'bearer' });
    expect(await commitConnectorAuthSecret('p', 'not-declared', 'X')).toEqual({ ok: true });
    expect(commits).toEqual(['chore: bind connector crm credential', 'chore: unbind connector crm credential']);
  });
});
