import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MAX_SESSION_ATTACHMENT_BYTES,
  sessionAttachmentRef,
  type SessionAttachmentScope,
} from "@kortix/shared";
import { getSupabase } from "../../shared/supabase";

const BUCKET = "session-attachments";
const missing = (error: any) =>
  ["404", "NoSuchKey", "NoSuchBucket"].includes(
    String(error?.statusCode ?? error?.code),
  ) || /not found|does not exist/i.test(error?.message ?? "");
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const key = (scope: SessionAttachmentScope) => {
  sessionAttachmentRef(scope);
  return `${scope.projectId}/${scope.sessionId}/${scope.attachmentId}`;
};

export function createSessionAttachmentStore(
  storage: SupabaseClient["storage"],
) {
  let bucketReady: Promise<void> | undefined;
  const ensureBucket = () =>
    (bucketReady ??= (async () => {
      const { data, error } = await storage.getBucket(BUCKET);
      if (data) {
        if (data.public)
          throw new Error("Session attachment storage must be private");
        if (typeof data.file_size_limit === 'number' && data.file_size_limit < MAX_SESSION_ATTACHMENT_BYTES) {
          const updated = await storage.updateBucket(BUCKET, { public: false, fileSizeLimit: MAX_SESSION_ATTACHMENT_BYTES });
          if (updated.error) throw updated.error;
        }
        return;
      }
      if (error && !missing(error)) throw error;
      const created = await storage.createBucket(BUCKET, {
        public: false,
        fileSizeLimit: MAX_SESSION_ATTACHMENT_BYTES,
      });
      if (created.error && !/already exists/i.test(created.error.message))
        throw created.error;
      if (created.error) {
        const checked = await storage.getBucket(BUCKET);
        if (checked.error || !checked.data || checked.data.public)
          throw new Error("Session attachment storage must be private");
      }
    })().catch((error) => {
      bucketReady = undefined;
      throw error;
    }));

  const read = async (scope: SessionAttachmentScope): Promise<Blob | null> => {
    const result = await storage.from(BUCKET).download(key(scope));
    if (result.error) {
      if (missing(result.error)) return null;
      throw result.error;
    }
    return result.data;
  };
  return {
    read,
    async put(
      input: SessionAttachmentScope & {
        filename: string;
        mime: string;
        bytes: Uint8Array;
      },
    ) {
      if (input.bytes.byteLength > MAX_SESSION_ATTACHMENT_BYTES)
        throw new Error("Attachments must be 50 MiB or smaller.");
      await ensureBucket();
      const result = await storage
        .from(BUCKET)
        .upload(key(input), input.bytes, {
          upsert: false,
          contentType: input.mime,
          cacheControl: "0",
        });
      if (result.error) {
        if (
          String((result.error as any).statusCode) !== "409" &&
          !/already exists|duplicate/i.test(result.error.message)
        )
          throw result.error;
        const existing = await read(input);
        if (
          !existing ||
          existing.size !== input.bytes.byteLength ||
          existing.type.split(";")[0] !== input.mime.split(";")[0] ||
          digest(new Uint8Array(await existing.arrayBuffer())) !==
            digest(input.bytes)
        ) {
          throw new Error("Attachment id already belongs to a different file");
        }
      }
      return {
        attachment_id: input.attachmentId,
        filename: input.filename,
        mime: input.mime,
        size: input.bytes.byteLength,
        url: sessionAttachmentRef(input),
      };
    },
    async remove(scope: SessionAttachmentScope) {
      const result = await storage.from(BUCKET).remove([key(scope)]);
      if (result.error && !missing(result.error)) throw result.error;
    },
    async removeSession(projectId: string, sessionId: string) {
      key({
        projectId,
        sessionId,
        attachmentId: "00000000-0000-0000-0000-000000000000",
      });
      const prefix = `${projectId}/${sessionId}`;
      for (;;) {
        const listed = await storage.from(BUCKET).list(prefix, { limit: 100 });
        if (listed.error) {
          if (missing(listed.error)) return;
          throw listed.error;
        }
        if (!listed.data?.length) return;
        const removed = await storage
          .from(BUCKET)
          .remove(listed.data.map((file) => `${prefix}/${file.name}`));
        if (removed.error) throw removed.error;
      }
    },
  };
}

let store: ReturnType<typeof createSessionAttachmentStore> | undefined;
export function sessionAttachmentStore() {
  return (store ??= createSessionAttachmentStore(getSupabase().storage));
}
