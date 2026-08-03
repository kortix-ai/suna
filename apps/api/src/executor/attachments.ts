import { executorAttachments } from '@kortix/db';
import { and, asc, eq, inArray, lt, or } from 'drizzle-orm';
import { db } from '../shared/db';
import { getSupabase } from '../shared/supabase';

export const MAX_EXECUTOR_ATTACHMENT_FILES = 20;
export const MAX_EXECUTOR_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const EXECUTOR_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;
const ATTACHMENT_CLAIM_TTL_MS = 10 * 60 * 1000;
const SIGNED_URL_TTL_SECONDS = 5 * 60;
const CONSUMED_OBJECT_GRACE_MS = 10 * 60 * 1000;
const ATTACHMENT_BUCKET = 'staged-files';
const CLEANUP_BATCH_SIZE = 100;

interface AttachmentCleanupCandidate {
  attachmentId: string;
  objectPath: string;
}

interface AttachmentCleanupDeps {
  removeObjects(paths: string[]): Promise<{ deletedPaths: string[] | null; error: boolean }>;
  deleteMetadata(attachmentIds: string[]): Promise<void>;
}

export interface ExecutorAttachmentScope {
  accountId: string;
  projectId: string;
  sessionId: string | null;
  userId: string;
}

export interface StageExecutorAttachmentInput {
  filename: string;
  contentType: string;
  contentDisposition: 'attachment' | 'inline';
  contentId?: string;
  bytes: Uint8Array;
}

export interface StagedExecutorAttachment {
  attachment_id: string;
  filename: string;
  content_type: string;
  content_disposition: 'attachment' | 'inline';
  content_id?: string;
  size: number;
  expires_at: string;
}

export interface ClaimedExecutorAttachments {
  args: Record<string, unknown>;
  claimToken: string | null;
  attachmentIds: string[];
}

export interface ExecutorAttachmentStore {
  stage(
    scope: ExecutorAttachmentScope,
    input: StageExecutorAttachmentInput,
  ): Promise<StagedExecutorAttachment>;
  claimForEmail(
    scope: ExecutorAttachmentScope,
    args: Record<string, unknown>,
  ): Promise<ClaimedExecutorAttachments>;
  completeClaim(claimToken: string, attachmentIds: string[]): Promise<void>;
  releaseClaim(claimToken: string, attachmentIds: string[]): Promise<void>;
}

type AttachmentRow = typeof executorAttachments.$inferSelect;

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function plainFilename(value: string): boolean {
  return (
    Boolean(value) &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\')
  );
}

function objectPath(scope: ExecutorAttachmentScope, attachmentId: string): string {
  return `executor-attachments/${scope.projectId}/${attachmentId}`;
}

export function validateClaimRows(
  rows: AttachmentRow[],
  ids: string[],
  scope: ExecutorAttachmentScope,
  now: Date,
): AttachmentRow[] {
  const byId = new Map(rows.map((row) => [row.attachmentId, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) throw new Error('attachment_not_found');
    if (
      row.accountId !== scope.accountId ||
      row.projectId !== scope.projectId ||
      row.sessionId !== scope.sessionId ||
      row.userId !== scope.userId
    ) {
      throw new Error('attachment_not_found');
    }
    if (row.expiresAt <= now) throw new Error('attachment_expired');
    if (row.status === 'consumed') throw new Error('attachment_already_consumed');
    if (
      row.status === 'claimed' &&
      (!row.claimExpiresAt || row.claimExpiresAt.getTime() > now.getTime())
    ) {
      throw new Error('attachment_in_use');
    }
    return row;
  });
}

class DbExecutorAttachmentStore implements ExecutorAttachmentStore {
  async stage(
    scope: ExecutorAttachmentScope,
    input: StageExecutorAttachmentInput,
  ): Promise<StagedExecutorAttachment> {
    if (!plainFilename(input.filename)) throw new Error('filename must be a plain filename');
    if (!input.contentType.trim()) throw new Error('content_type is required');
    if (input.bytes.byteLength === 0) throw new Error('attachment is empty');
    if (input.bytes.byteLength > MAX_EXECUTOR_ATTACHMENT_BYTES) {
      throw new Error('attachment exceeds the 25 MiB limit');
    }

    const attachmentId = crypto.randomUUID();
    const path = objectPath(scope, attachmentId);
    const expiresAt = new Date(Date.now() + EXECUTOR_ATTACHMENT_TTL_MS);
    const supabase = getSupabase();

    // Persist the cleanup key before touching object storage. If the upload has
    // an ambiguous outcome (for example, the provider stored the bytes but the
    // response was lost), maintenance still has enough metadata to remove it.
    await db.insert(executorAttachments).values({
      attachmentId,
      accountId: scope.accountId,
      projectId: scope.projectId,
      sessionId: scope.sessionId,
      userId: scope.userId,
      objectPath: path,
      filename: input.filename,
      contentType: input.contentType,
      contentDisposition: input.contentDisposition,
      contentId: input.contentId ?? null,
      sizeBytes: input.bytes.byteLength,
      expiresAt,
    });

    const { error: uploadError } = await supabase.storage
      .from(ATTACHMENT_BUCKET)
      .upload(path, input.bytes, {
        upsert: false,
        contentType: input.contentType,
      });
    if (uploadError) {
      const { error: removeError } = await supabase.storage.from(ATTACHMENT_BUCKET).remove([path]);
      // Delete metadata only after storage confirms cleanup. On an ambiguous
      // remove failure, retain the row so the expiry sweep can retry safely.
      if (!removeError) {
        await db
          .delete(executorAttachments)
          .where(eq(executorAttachments.attachmentId, attachmentId))
          .catch(() => {});
      }
      throw uploadError;
    }

    return {
      attachment_id: attachmentId,
      filename: input.filename,
      content_type: input.contentType,
      content_disposition: input.contentDisposition,
      ...(input.contentId ? { content_id: input.contentId } : {}),
      size: input.bytes.byteLength,
      expires_at: expiresAt.toISOString(),
    };
  }

  async claimForEmail(
    scope: ExecutorAttachmentScope,
    args: Record<string, unknown>,
  ): Promise<ClaimedExecutorAttachments> {
    const attachments = args.attachments;
    if (!Array.isArray(attachments)) {
      return { args, claimToken: null, attachmentIds: [] };
    }
    if (attachments.length > MAX_EXECUTOR_ATTACHMENT_FILES) {
      throw new Error(`attachments supports at most ${MAX_EXECUTOR_ATTACHMENT_FILES} files`);
    }

    const handleItems = attachments.flatMap((value, index) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const attachmentId = (value as Record<string, unknown>).attachment_id;
      if (attachmentId === undefined) return [];
      if (typeof attachmentId !== 'string' || !isUuid(attachmentId)) {
        throw new Error(`attachments[${index}].attachment_id is invalid`);
      }
      return [{ index, attachmentId }];
    });
    if (handleItems.length === 0) {
      return { args, claimToken: null, attachmentIds: [] };
    }
    const ids = handleItems.map((item) => item.attachmentId);
    if (new Set(ids).size !== ids.length) throw new Error('duplicate attachment_id');

    const now = new Date();
    const claimToken = crypto.randomUUID();
    const claimExpiresAt = new Date(now.getTime() + ATTACHMENT_CLAIM_TTL_MS);
    const rows = await db.transaction(async (tx) => {
      const locked = await tx
        .select()
        .from(executorAttachments)
        .where(inArray(executorAttachments.attachmentId, ids))
        .orderBy(asc(executorAttachments.attachmentId))
        .for('update');
      const ordered = validateClaimRows(locked, ids, scope, now);
      const totalBytes = ordered.reduce((sum, row) => sum + row.sizeBytes, 0);
      if (totalBytes > MAX_EXECUTOR_ATTACHMENT_BYTES) {
        throw new Error('attachments exceeds the 25 MiB aggregate limit');
      }
      await tx
        .update(executorAttachments)
        .set({ status: 'claimed', claimToken, claimExpiresAt })
        .where(inArray(executorAttachments.attachmentId, ids));
      return ordered;
    });

    const supabase = getSupabase();
    try {
      const signed = await Promise.all(
        rows.map(async (row) => {
          const { data, error } = await supabase.storage
            .from(ATTACHMENT_BUCKET)
            .createSignedUrl(row.objectPath, SIGNED_URL_TTL_SECONDS, {
              download: row.filename,
            });
          if (error || !data?.signedUrl) {
            throw error ?? new Error('failed to create attachment URL');
          }
          return {
            filename: row.filename,
            content_type: row.contentType,
            content_disposition: row.contentDisposition as 'attachment' | 'inline',
            ...(row.contentId ? { content_id: row.contentId } : {}),
            url: data.signedUrl,
          };
        }),
      );
      const next = [...attachments];
      handleItems.forEach((item, index) => {
        next[item.index] = signed[index];
      });
      return {
        args: { ...args, attachments: next },
        claimToken,
        attachmentIds: ids,
      };
    } catch (error) {
      await this.releaseClaim(claimToken, ids).catch(() => {});
      throw error;
    }
  }

  async completeClaim(claimToken: string, attachmentIds: string[]): Promise<void> {
    if (attachmentIds.length === 0) return;
    const now = new Date();
    await db
      .update(executorAttachments)
      .set({
        status: 'consumed',
        consumedAt: now,
        claimToken: null,
        claimExpiresAt: null,
      })
      .where(
        and(
          inArray(executorAttachments.attachmentId, attachmentIds),
          eq(executorAttachments.status, 'claimed'),
          eq(executorAttachments.claimToken, claimToken),
        ),
      );
  }

  async releaseClaim(claimToken: string, attachmentIds: string[]): Promise<void> {
    if (attachmentIds.length === 0) return;
    await db
      .update(executorAttachments)
      .set({ status: 'uploaded', claimToken: null, claimExpiresAt: null })
      .where(
        and(
          inArray(executorAttachments.attachmentId, attachmentIds),
          eq(executorAttachments.status, 'claimed'),
          eq(executorAttachments.claimToken, claimToken),
        ),
      );
  }
}

export const executorAttachmentStore: ExecutorAttachmentStore = new DbExecutorAttachmentStore();

export async function cleanupExecutorAttachmentCandidates(
  rows: AttachmentCleanupCandidate[],
  deps: AttachmentCleanupDeps,
): Promise<{ deleted: number; errors: number }> {
  if (rows.length === 0) return { deleted: 0, errors: 0 };

  const removal = await deps.removeObjects(rows.map((row) => row.objectPath));
  if (removal.error) return { deleted: 0, errors: rows.length };

  // Supabase may return an empty body for a successful bulk delete. A null
  // confirmation therefore means the whole request succeeded; a concrete
  // list lets us retain metadata for any object the provider did not remove.
  const deletedPaths = removal.deletedPaths ? new Set(removal.deletedPaths) : null;
  const deletable = deletedPaths ? rows.filter((row) => deletedPaths.has(row.objectPath)) : rows;
  if (deletable.length > 0) {
    await deps.deleteMetadata(deletable.map((row) => row.attachmentId));
  }
  return { deleted: deletable.length, errors: rows.length - deletable.length };
}

export async function cleanupExpiredExecutorAttachments(now = new Date()): Promise<{
  deleted: number;
  errors: number;
}> {
  const rows = await db
    .select({
      attachmentId: executorAttachments.attachmentId,
      objectPath: executorAttachments.objectPath,
    })
    .from(executorAttachments)
    .where(
      or(
        lt(executorAttachments.expiresAt, now),
        and(
          eq(executorAttachments.status, 'consumed'),
          lt(executorAttachments.consumedAt, new Date(now.getTime() - CONSUMED_OBJECT_GRACE_MS)),
        ),
      ),
    )
    .limit(CLEANUP_BATCH_SIZE);
  return cleanupExecutorAttachmentCandidates(rows, {
    removeObjects: async (paths) => {
      const { data, error } = await getSupabase().storage.from(ATTACHMENT_BUCKET).remove(paths);
      return {
        deletedPaths: data && data.length > 0 ? data.map((item) => item.name) : null,
        error: Boolean(error),
      };
    },
    deleteMetadata: async (attachmentIds) => {
      await db
        .delete(executorAttachments)
        .where(inArray(executorAttachments.attachmentId, attachmentIds));
    },
  });
}
