import { describe, expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConnectorClient } from '../connector-gateway/gateway';
import { uploadAttachmentFiles } from '../connector-gateway/mcp';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kortix-email-attachments-'));
  await mkdir(join(root, 'output'));
  await mkdir(join(root, 'artifacts'));
  return root;
}

describe('Connector MCP attachment_files', () => {
  test('uploads raw bytes and returns opaque handles without producing base64', async () => {
    const root = await fixture();
    const pdf = join(root, 'output', 'memo.pdf');
    const xlsx = join(root, 'artifacts', 'model.xlsx');
    await writeFile(pdf, 'pdf-bytes');
    await writeFile(xlsx, 'xlsx-bytes');

    const uploads: Array<{ bytes: Uint8Array; metadata: Record<string, unknown> }> = [];
    const connector = {
      uploadAttachment: async (bytes: Uint8Array, metadata: Record<string, unknown>) => {
        uploads.push({ bytes, metadata });
        return {
          attachment_id: `attachment-${uploads.length}`,
          filename: metadata.filename as string,
          content_type: metadata.contentType as string,
          content_disposition: 'attachment' as const,
          size: bytes.byteLength,
          expires_at: '2026-08-03T20:00:00.000Z',
        };
      },
    } as unknown as ConnectorClient;

    const result = await uploadAttachmentFiles(
      [{ path: pdf, filename: 'Investment Memo.pdf' }, { path: xlsx }],
      connector,
      { workspaceRoot: root },
    );

    expect(result).toEqual([
      {
        filename: 'Investment Memo.pdf',
        content_type: 'application/pdf',
        content_disposition: 'attachment',
        attachment_id: 'attachment-1',
      },
      {
        filename: 'model.xlsx',
        content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        content_disposition: 'attachment',
        attachment_id: 'attachment-2',
      },
    ]);
    const firstUpload = uploads[0];
    const secondUpload = uploads[1];
    if (!firstUpload || !secondUpload) throw new Error('expected two uploads');
    expect(new TextDecoder().decode(firstUpload.bytes)).toBe('pdf-bytes');
    expect(new TextDecoder().decode(secondUpload.bytes)).toBe('xlsx-bytes');
    expect(JSON.stringify(result)).not.toContain(Buffer.from('pdf-bytes').toString('base64'));
  });

  test('rejects files outside generated-artifact directories, including symlinks', async () => {
    const root = await fixture();
    const secret = join(root, 'secret.txt');
    const link = join(root, 'output', 'report.txt');
    await writeFile(secret, 'do-not-send');
    await symlink(secret, link);

    await expect(
      uploadAttachmentFiles([{ path: link }], {} as ConnectorClient, { workspaceRoot: root }),
    ).rejects.toThrow('must not be a symbolic link');
  });

  test('rejects hard-linked aliases of files outside generated-artifact directories', async () => {
    const root = await fixture();
    const secret = join(root, 'secret.txt');
    const alias = join(root, 'output', 'report.txt');
    await writeFile(secret, 'do-not-send');
    await link(secret, alias);

    await expect(
      uploadAttachmentFiles([{ path: alias }], {} as ConnectorClient, { workspaceRoot: root }),
    ).rejects.toThrow('must not have hard links');
  });

  test('rejects a path that changes after the file descriptor is opened', async () => {
    const root = await fixture();
    const report = join(root, 'output', 'report.txt');
    const secret = join(root, 'secret.txt');
    await writeFile(report, 'safe-report');
    await writeFile(secret, 'do-not-send');

    await expect(
      uploadAttachmentFiles([{ path: report }], {} as ConnectorClient, {
        workspaceRoot: root,
        afterOpen: async () => {
          await rm(report);
          await symlink(secret, report);
        },
      }),
    ).rejects.toThrow('must be inside /workspace/{output,artifacts,reports,deliverables}');
  });

  test('rejects aggregate payloads over the local safety limit', async () => {
    const root = await fixture();
    const first = join(root, 'output', 'one.txt');
    const second = join(root, 'output', 'two.txt');
    await writeFile(first, '12345');
    await writeFile(second, '67890');

    await expect(
      uploadAttachmentFiles(
        [{ path: first }, { path: second }],
        {
          uploadAttachment: async () => ({
            attachment_id: 'attachment-1',
          }),
        } as unknown as ConnectorClient,
        {
          workspaceRoot: root,
          maxBytes: 9,
        },
      ),
    ).rejects.toThrow('aggregate limit');
  });
});
