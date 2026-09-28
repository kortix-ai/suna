import { promptAttachments, promptAttachmentReferences, sessionLifecycleCommands, sessionSandboxes } from '@kortix/db';
import { MAX_PROMPT_ATTACHMENT_BYTES } from '@kortix/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../shared/db';
import { toPublicStorageUrl } from '../shared/supabase';
import { buildPromptAttachmentReference } from './session-lifecycle/prompt-attachment-reference';
import type { PromptPartWire } from './session-lifecycle/store';
import { PromptAttachmentError, download, filePath, digest, storage } from './prompt-attachment-storage';

interface PromptAttachmentHandle {
  attachmentId: string;
  partIndex: number;
}

interface ResolvedCommandAttachment {
  attachmentId: string;
  objectPath: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  targetPath: string;
  readBytes(): Promise<Uint8Array>;
}

const commandAttachmentUnavailable = () =>
  new PromptAttachmentError('attachment_not_found', 'The command attachment is unavailable.', 404);

/** Internal only: the caller must name the persisted command and its scope.
 * Resolves every handle of one running command with one query and signs
 * nothing. A handle that is not this command's verified part is absent from the
 * result. */
export async function resolvePromptAttachments(input: {
  commandId: string;
  projectId: string;
  accountId: string;
  sessionId: string;
  handles: PromptAttachmentHandle[];
}): Promise<Map<number, ResolvedCommandAttachment>> {
  const resolved = new Map<number, ResolvedCommandAttachment>();
  const ids = [...new Set(input.handles.map((handle) => handle.attachmentId))];
  if (!ids.length) return resolved;
  const found = await db
    .select({
      attachment: promptAttachments,
      commandStatus: sessionLifecycleCommands.status,
      commandPayload: sessionLifecycleCommands.payload,
    })
    .from(promptAttachmentReferences)
    .innerJoin(
      promptAttachments,
      eq(promptAttachments.attachmentId, promptAttachmentReferences.attachmentId),
    )
    .innerJoin(
      sessionLifecycleCommands,
      eq(sessionLifecycleCommands.commandId, promptAttachmentReferences.commandId),
    )
    .where(
      and(
        inArray(promptAttachmentReferences.attachmentId, ids),
        eq(promptAttachmentReferences.commandId, input.commandId),
        eq(sessionLifecycleCommands.projectId, input.projectId),
        eq(sessionLifecycleCommands.accountId, input.accountId),
        eq(promptAttachments.projectId, input.projectId),
        eq(promptAttachments.accountId, input.accountId),
        eq(sessionLifecycleCommands.sessionId, input.sessionId),
      ),
    );
  if (!found.length) return resolved;
  const parts = Array.isArray(found[0]!.commandPayload.parts)
    ? (found[0]!.commandPayload.parts as PromptPartWire[])
    : [];
  const rows = new Map(found.map(({ attachment }) => [attachment.attachmentId, attachment]));
  // A handle's shape does not depend on the command's status: the payload that
  // decides it is on the same row. So check the handle FIRST. A wrong part
  // index is permanently wrong and reports 404 whatever the command is doing —
  // ordering the status check first made that 404 unreachable for a command
  // that had left `running`, which answered the same wrong index 404 or 409 on
  // timing alone and told the caller to retry an error no retry can fix.
  const verified: Array<{
    row: NonNullable<ReturnType<typeof rows.get>>;
    partIndex: number;
    sha256: string;
  }> = [];
  for (const { attachmentId, partIndex } of input.handles) {
    const row = rows.get(attachmentId);
    const part = parts[partIndex];
    const matchingParts = parts.filter(
      (candidate) => candidate?.type === 'file' && candidate.attachment_id === attachmentId,
    );
    if (
      !row ||
      !Number.isSafeInteger(partIndex) ||
      partIndex < 0 ||
      part?.type !== 'file' ||
      part.attachment_id !== attachmentId ||
      matchingParts.length !== 1 ||
      row.status !== 'ready' ||
      !row.sha256 ||
      !/^[0-9a-f]{64}$/.test(row.sha256) ||
      row.sizeBytes <= 0 ||
      row.sizeBytes > MAX_PROMPT_ATTACHMENT_BYTES
    )
      continue;
    verified.push({ row, partIndex, sha256: row.sha256 });
  }
  // No handle names a real part of this command: absent from the result, so the
  // caller reports 404. Every row joins the same command, so one status decides
  // the rest — a handle that WOULD resolve keeps the transient 409, which stays
  // distinguishable from the permanent 404 above.
  if (!verified.length) return resolved;
  if (found[0]!.commandStatus !== 'running')
    throw new PromptAttachmentError(
      'attachment_command_not_running',
      'The command attachment is not active.',
      409,
    );
  for (const { row, partIndex, sha256 } of verified) {
    const reference = buildPromptAttachmentReference({
      part: { type: 'file', filename: row.filename, mime: row.mime },
      index: partIndex,
      materializationKey: input.commandId,
    });
    resolved.set(partIndex, {
      attachmentId: row.attachmentId,
      objectPath: row.objectPath,
      filename: row.filename,
      mime: row.mime,
      size: row.sizeBytes,
      sha256,
      targetPath: reference.targetPath,
      async readBytes(): Promise<Uint8Array> {
        const bytes = await download(filePath(row));
        if (bytes.byteLength !== row.sizeBytes || digest(bytes) !== sha256)
          throw new PromptAttachmentError(
            'attachment_integrity_failed',
            'Attachment bytes failed verification.',
          );
        return bytes;
      },
    });
  }
  return resolved;
}

/** One handle of one running command. */
export async function resolvePromptAttachment(
  input: PromptAttachmentHandle & {
    commandId: string;
    projectId: string;
    accountId: string;
    sessionId: string;
  },
): Promise<ResolvedCommandAttachment> {
  const { attachmentId, partIndex, ...command } = input;
  const resolved = (
    await resolvePromptAttachments({ ...command, handles: [{ attachmentId, partIndex }] })
  ).get(partIndex);
  if (!resolved) throw commandAttachmentUnavailable();
  return resolved;
}

/** Resolve the descriptor available to one live session sandbox credential. */
export async function resolveRuntimePromptAttachmentDescriptor(input: {
  sandboxId: string;
  accountId: string;
  projectId: string;
  commandId: string;
  attachmentId: string;
  partIndex: number;
}) {
  const [sandbox] = await db
    .select({ sessionId: sessionSandboxes.sessionId })
    .from(sessionSandboxes)
    .where(
      and(
        eq(sessionSandboxes.sandboxId, input.sandboxId),
        eq(sessionSandboxes.accountId, input.accountId),
        eq(sessionSandboxes.projectId, input.projectId),
        inArray(sessionSandboxes.status, ['provisioning', 'active']),
      ),
    )
    .limit(1);
  if (!sandbox)
    throw new PromptAttachmentError(
      'attachment_not_found',
      'The command attachment is unavailable.',
      404,
    );
  const resolved = await resolvePromptAttachment({
    attachmentId: input.attachmentId,
    commandId: input.commandId,
    projectId: input.projectId,
    accountId: input.accountId,
    sessionId: sandbox.sessionId,
    partIndex: input.partIndex,
  });
  // The only signed download URL: the daemon fetches it directly.
  const { data, error } = await storage().createSignedUrl(filePath(resolved), 5 * 60);
  if (error || !data?.signedUrl)
    throw new PromptAttachmentError(
      'attachment_storage_unavailable',
      'Attachment storage is unavailable.',
      503,
    );
  return {
    version: 1 as const,
    command_id: input.commandId,
    attachment_id: resolved.attachmentId,
    part_index: input.partIndex,
    filename: resolved.filename,
    mime: resolved.mime,
    size_bytes: resolved.size,
    sha256: resolved.sha256,
    target_path: resolved.targetPath,
    download_url: toPublicStorageUrl(data.signedUrl),
    download_expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
}
