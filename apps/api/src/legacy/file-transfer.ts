import postgres from 'postgres';
import { config } from '../config';
import { getDaytona, isDaytonaConfigured } from '../shared/daytona';
import { resolveSandboxEndpoint } from './sandbox-writer';
import type { Sandbox } from '@daytonaio/sdk';

export interface FileTransferResult {
  transferred: boolean;
  fileCount: number;
  archiveSize: number;
  errors: string[];
}

interface OldSandboxInfo {
  externalId: string;
  config: Record<string, unknown>;
}

const ARCHIVE_PATH = '/tmp/legacy-uploads.tar.gz';
const TRANSFER_DIRS = ['/workspace'];

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function toSafePathSegment(value: string): string {
  return encodeURIComponent(value);
}

export async function getOldSandboxId(projectId: string): Promise<OldSandboxInfo | null> {
  const sql = postgres(config.DATABASE_URL!, { max: 1 });
  try {
    const resourceRows = await sql`
      SELECT r.external_id, r.config
      FROM projects p
      JOIN resources r ON r.id = p.sandbox_resource_id
      WHERE p.project_id = ${projectId}
        AND r.type = 'sandbox'
        AND r.external_id IS NOT NULL
      LIMIT 1
    `;

    if (resourceRows.length > 0) {
      return {
        externalId: resourceRows[0].external_id,
        config: (resourceRows[0].config || {}) as Record<string, unknown>,
      };
    }

    const legacyRows = await sql`
      SELECT sandbox
      FROM projects
      WHERE project_id = ${projectId}
        AND sandbox IS NOT NULL
        AND sandbox::text != '{}'
    `;

    if (legacyRows.length > 0) {
      const sandbox = legacyRows[0].sandbox as Record<string, unknown>;
      const id = sandbox?.id as string;
      if (id) {
        return { externalId: id, config: sandbox };
      }
    }

    return null;
  } catch (err: any) {
    if (err?.code === '42P01' || err?.code === '42703') {
      return null;
    }
    throw err;
  } finally {
    await sql.end();
  }
}

async function bootOldSandbox(externalId: string): Promise<Sandbox> {
  if (!isDaytonaConfigured()) {
    throw new Error('Daytona not configured — cannot boot old sandbox');
  }

  const daytona = getDaytona();
  const sandbox = await daytona.get(externalId);

  if (sandbox.state === 'started') {
    return sandbox;
  }

  if (sandbox.state === 'stopped' || sandbox.state === 'archived') {
    console.log(`[file-transfer] Starting old sandbox ${externalId} (was ${sandbox.state})`);
    await daytona.start(sandbox, 120);
    return sandbox;
  }

  throw new Error(`Old sandbox ${externalId} is in unrecoverable state: ${sandbox.state}`);
}

async function tarFilesInOldSandbox(sandbox: Sandbox): Promise<{ fileCount: number }> {
  const dirsWithFiles: string[] = [];
  for (const dir of TRANSFER_DIRS) {
    const check = await sandbox.process.executeCommand(
      `[ -d "${dir}" ] && find "${dir}" -type f | head -1`,
    );
    if (check.result?.trim()) {
      dirsWithFiles.push(dir);
    }
  }

  if (dirsWithFiles.length === 0) {
    return { fileCount: 0 };
  }

  const countCmd = dirsWithFiles
    .map((d) => `find "${d}" -type f`)
    .join('; ');
  const countResult = await sandbox.process.executeCommand(`(${countCmd}) | wc -l`);
  const fileCount = parseInt(countResult.result?.trim() || '0', 10);

  if (fileCount === 0) {
    return { fileCount: 0 };
  }

  const tarSources = dirsWithFiles.map((d) => `"${d}"`).join(' ');
  const tarResult = await sandbox.process.executeCommand(
    `tar czf ${shellQuote(ARCHIVE_PATH)} ${tarSources} 2>&1`,
    undefined,
    undefined,
    120,
  );

  if (tarResult.exitCode !== 0) {
    throw new Error(`tar failed (exit ${tarResult.exitCode}): ${tarResult.result}`);
  }

  return { fileCount };
}

function toBuffer(content: unknown): Buffer {
  if (content instanceof Buffer) return content;
  if (typeof content === 'string') return Buffer.from(content);
  if (content instanceof ArrayBuffer) return Buffer.from(content);
  return Buffer.from(content as any);
}

async function uploadAndExtractOnNewSandbox(
  baseUrl: string,
  headers: Record<string, string>,
  archive: Buffer,
  destPath: string,
): Promise<void> {
  const uploadUrl = `${baseUrl}/file/upload`;
  console.log(`[file-transfer] Uploading archive (${archive.length} bytes) to ${uploadUrl}`);

  const formData = new FormData();
  formData.append('path', '/tmp');
  formData.append('file', new Blob([new Uint8Array(archive)]), 'legacy-uploads.tar.gz');

  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      ...Object.fromEntries(
        Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'content-type'),
      ),
    },
    body: formData,
    signal: AbortSignal.timeout(120_000),
  });

  const uploadBody = await uploadRes.text().catch(() => '');
  console.log(`[file-transfer] Upload response (${uploadRes.status}): ${uploadBody.slice(0, 500)}`);

  if (!uploadRes.ok) {
    throw new Error(`Archive upload failed (${uploadRes.status}): ${uploadBody.slice(0, 300)}`);
  }

  // The upload endpoint guarantees collision-free writes and returns the
  // actual path the archive was stored at. Parse it so extraction targets
  // the right file even if `/tmp/legacy-uploads.tar.gz` already existed.
  let archivePath = ARCHIVE_PATH;
  try {
    const parsed = JSON.parse(uploadBody) as Array<{ path: string; size: number }>;
    if (Array.isArray(parsed) && parsed[0]?.path) {
      archivePath = parsed[0].path;
    }
  } catch {
    console.warn(`[file-transfer] Could not parse upload response; falling back to ${ARCHIVE_PATH}`);
  }

  console.log(`[file-transfer] Archive uploaded to ${archivePath}, extracting on new sandbox...`);

  const quotedDestPath = shellQuote(destPath);
  const quotedArchivePath = shellQuote(archivePath);

  const execRes = await fetch(`${baseUrl}/kortix/core/exec`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cmd: `mkdir -p ${quotedDestPath} && tar xzf ${quotedArchivePath} --strip-components=1 -C ${quotedDestPath} && rm -f ${quotedArchivePath}`,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  const execBody = await execRes.text();
  console.log(`[file-transfer] Exec response (${execRes.status}): ${execBody.slice(0, 500)}`);

  if (!execRes.ok) {
    throw new Error(`Archive extract failed (${execRes.status}): ${execBody.slice(0, 300)}`);
  }

  let execResult: { code: number; stdout: string; stderr: string };
  try {
    execResult = JSON.parse(execBody);
  } catch {
    throw new Error(`Exec returned non-JSON (${execRes.status}): ${execBody.slice(0, 300)}`);
  }

  if (execResult.code !== 0) {
    throw new Error(`tar extract failed (exit ${execResult.code}): ${execResult.stderr}`);
  }
}

export async function transferFiles(
  projectId: string,
  newSandboxExternalId: string,
  threadId?: string,
): Promise<FileTransferResult> {
  const result: FileTransferResult = {
    transferred: false,
    fileCount: 0,
    archiveSize: 0,
    errors: [],
  };

  const oldSandbox = await getOldSandboxId(projectId);
  if (!oldSandbox) {
    console.log(`[file-transfer] No old sandbox found for project ${projectId}`);
    return result;
  }

  console.log(`[file-transfer] Old sandbox: ${oldSandbox.externalId} for project ${projectId}`);

  const { baseUrl, serviceKey, previewToken, proxyToken } = await resolveSandboxEndpoint(newSandboxExternalId);
  const headers: Record<string, string> = {
    ...(serviceKey ? { Authorization: `Bearer ${serviceKey}` } : {}),
    ...(previewToken ? { 'X-Daytona-Preview-Token': previewToken } : {}),
    ...(proxyToken ? { 'X-Proxy-Token': proxyToken } : {}),
    'X-Daytona-Skip-Preview-Warning': 'true',
  };

  let oldSandboxInstance: Sandbox;
  try {
    oldSandboxInstance = await bootOldSandbox(oldSandbox.externalId);
  } catch (err: any) {
    console.error(`[file-transfer] Cannot boot old sandbox ${oldSandbox.externalId}: ${err.message}`);
    result.errors.push(`Cannot boot old sandbox: ${err.message}`);
    return result;
  }

  let fileCount: number;
  try {
    const tarResult = await tarFilesInOldSandbox(oldSandboxInstance);
    fileCount = tarResult.fileCount;
  } catch (err: any) {
    result.errors.push(`Tar failed: ${err.message}`);
    return result;
  }

  if (fileCount === 0) {
    console.log(`[file-transfer] No files to transfer from ${oldSandbox.externalId}`);
    return result;
  }

  result.fileCount = fileCount;
  console.log(`[file-transfer] Tarred ${fileCount} files in old sandbox`);

  let archive: Buffer;
  try {
    const raw = await oldSandboxInstance.fs.downloadFile(ARCHIVE_PATH);
    archive = toBuffer(raw);
    result.archiveSize = archive.length;
    console.log(`[file-transfer] Downloaded archive: ${(archive.length / 1024 / 1024).toFixed(1)} MB`);
  } catch (err: any) {
    result.errors.push(`Archive download failed: ${err.message}`);
    return result;
  }

  try {
    const destPath = threadId
      ? `/workspace/legacy/${toSafePathSegment(threadId)}`
      : '/workspace/legacy';
    console.log(`[file-transfer] Starting upload/extract to ${destPath} via ${baseUrl}`);
    await uploadAndExtractOnNewSandbox(baseUrl, headers, archive, destPath);
    result.transferred = true;
    console.log(`[file-transfer] Extracted ${fileCount} files on new sandbox`);
  } catch (err: any) {
    console.error(`[file-transfer] Upload/extract failed:`, err.message);
    result.errors.push(`Upload/extract failed: ${err.message}`);
    return result;
  }

  try {
    await oldSandboxInstance.process.executeCommand(`rm -f ${shellQuote(ARCHIVE_PATH)}`);
    const daytona = getDaytona();
    await daytona.stop(oldSandboxInstance);
    console.log(`[file-transfer] Stopped old sandbox ${oldSandbox.externalId}`);
  } catch {
  }

  console.log(`[file-transfer] Done: ${fileCount} files transferred`);
  return result;
}
