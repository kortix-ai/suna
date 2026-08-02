import { describe, expect, test } from 'bun:test';
import { extractKnowledgeDocument } from './agent-knowledge-extract';

const bytes = (value: string) => new TextEncoder().encode(value);

describe('extractKnowledgeDocument', () => {
  test('splits Markdown into heading-aware blocks', async () => {
    const blocks = await extractKnowledgeDocument({
      body: bytes('# Runbook\n\nOverview.\n\n## Escalation\n\nPage the incident lead.'),
      contentType: 'text/markdown',
      fileName: 'runbook.md',
    });

    expect(blocks).toEqual([
      { text: 'Runbook\n\nOverview.', locator: { heading: 'Runbook' } },
      {
        text: 'Escalation\n\nPage the incident lead.',
        locator: { heading: 'Runbook > Escalation' },
      },
    ]);
  });

  test('parses quoted CSV rows with stable row locators', async () => {
    const blocks = await extractKnowledgeDocument({
      body: bytes('name,notes\nAlice,"Primary, on-call"\nBob,Backup'),
      contentType: 'text/csv',
      fileName: 'owners.csv',
    });

    expect(blocks).toEqual([
      { text: 'name: Alice\nnotes: Primary, on-call', locator: { row: 2 } },
      { text: 'name: Bob\nnotes: Backup', locator: { row: 3 } },
    ]);
  });

  test('extracts HTML sections without executable or navigation content', async () => {
    const blocks = await extractKnowledgeDocument({
      body: bytes(`
        <html><body>
          <nav>Ignore navigation</nav>
          <h1>Policy</h1><p>Keep this paragraph.</p>
          <script>ignoreScript()</script>
          <h2>Exceptions</h2><p>Document every exception.</p>
        </body></html>
      `),
      contentType: 'text/html; charset=utf-8',
      url: 'https://docs.example.com/policy',
    });

    expect(blocks).toEqual([
      {
        text: 'Policy\n\nKeep this paragraph.',
        locator: { heading: 'Policy', url: 'https://docs.example.com/policy' },
      },
      {
        text: 'Exceptions\n\nDocument every exception.',
        locator: {
          heading: 'Policy > Exceptions',
          url: 'https://docs.example.com/policy',
        },
      },
    ]);
  });

  test('uses filename extensions when servers return a generic content type', async () => {
    const blocks = await extractKnowledgeDocument({
      body: bytes('plain knowledge'),
      contentType: 'application/octet-stream',
      fileName: 'knowledge.txt',
    });
    expect(blocks).toEqual([{ text: 'plain knowledge', locator: {} }]);
  });

  test('rejects unsupported and empty documents', async () => {
    await expect(
      extractKnowledgeDocument({
        body: bytes('binary'),
        contentType: 'application/zip',
        fileName: 'knowledge.zip',
      }),
    ).rejects.toThrow('Unsupported knowledge document type');

    await expect(
      extractKnowledgeDocument({ body: bytes('   '), contentType: 'text/plain' }),
    ).rejects.toThrow('Knowledge document contains no indexable text');
  });
});
