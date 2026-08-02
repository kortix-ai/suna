import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encodeAttachmentFiles } from '../executor/mcp';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kortix-email-attachments-'));
  await mkdir(join(root, 'output'));
  await mkdir(join(root, 'artifacts'));
  return root;
}

describe('Executor MCP attachment_files', () => {
  test('encodes multiple generated files without putting base64 in the tool call', async () => {
    const root = await fixture();
    const pdf = join(root, 'output', 'memo.pdf');
    const xlsx = join(root, 'artifacts', 'model.xlsx');
    await writeFile(pdf, 'pdf-bytes');
    await writeFile(xlsx, 'xlsx-bytes');

    const result = await encodeAttachmentFiles([{ path: pdf, filename: 'Investment Memo.pdf' }, { path: xlsx }], {
      workspaceRoot: root,
    });

    expect(result).toEqual([
      {
        filename: 'Investment Memo.pdf',
        content_type: 'application/pdf',
        content_disposition: 'attachment',
        content: Buffer.from('pdf-bytes').toString('base64'),
      },
      {
        filename: 'model.xlsx',
        content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        content_disposition: 'attachment',
        content: Buffer.from('xlsx-bytes').toString('base64'),
      },
    ]);
  });

  test('rejects files outside generated-artifact directories, including symlinks', async () => {
    const root = await fixture();
    const secret = join(root, 'secret.txt');
    const link = join(root, 'output', 'report.txt');
    await writeFile(secret, 'do-not-send');
    await symlink(secret, link);

    await expect(encodeAttachmentFiles([{ path: link }], { workspaceRoot: root })).rejects.toThrow('must be inside /workspace/{output,artifacts,reports,deliverables}');
  });

  test('rejects aggregate payloads over the local safety limit', async () => {
    const root = await fixture();
    const first = join(root, 'output', 'one.txt');
    const second = join(root, 'output', 'two.txt');
    await writeFile(first, '12345');
    await writeFile(second, '67890');

    await expect(
      encodeAttachmentFiles([{ path: first }, { path: second }], {
        workspaceRoot: root,
        maxBytes: 9,
      }),
    ).rejects.toThrow('aggregate limit');
  });
});
