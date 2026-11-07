import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MAX_SESSION_ATTACHMENT_BYTES,
  sessionAttachmentRef,
  type SessionAttachmentScope,
} from "@kortix/shared";
import { getSupabase } from "../../shared/supabase";

const BUCKET = "session-attachments";
type StorageError = { statusCode?: string | number; code?: string; message?: string };
const missing = (error: StorageError) =>
  ["404", "NoSuchKey", "NoSuchBucket"].includes(
    String(error?.statusCode ?? error?.code),
  ) || /not found|does not exist/i.test(error?.message ?? "");
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const key = (scope: SessionAttachmentScope) => {
  sessionAttachmentRef(scope);
  return `${scope.projectId}/${scope.sessionId}/${scope.attachmentId}`;
};

/**
 * The private `session-attachments` bucket. A migration creates it
 * (20261011231931109_session_attachments_bucket.sql); this store never creates
 * a bucket or changes its settings.
 */
export function createSessionAttachmentStore(
  storage: SupabaseClient["storage"],
) {
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
      const result = await storage
        .from(BUCKET)
        .upload(key(input), input.bytes, {
          upsert: false,
          contentType: input.mime,
          cacheControl: "0",
        });
      if (result.error) {
        const failure: StorageError = result.error;
        if (
          String(failure.statusCode) !== "409" &&
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
      await removePrefix(`${projectId}/${sessionId}`);
    },
    /**
     * Every session's files under one project. Storage lists one level, and
     * each session is one folder under the project, so this lists the project
     * and empties each folder it names.
     */
    async removeProject(projectId: string) {
      await drainListing(projectId, `Could not delete the session files of project ${projectId}`, async (names) => {
        for (const name of names) await removePrefix(`${projectId}/${name}`);
      });
    },
  };

  /** Delete every object one level under `prefix`, a page at a time. */
  async function removePrefix(prefix: string) {
    await drainListing(prefix, `Could not delete the files under ${prefix}`, async (names) => {
      const removed = await storage
        .from(BUCKET)
        .remove(names.map((name) => `${prefix}/${name}`));
      if (removed.error) throw removed.error;
    });
  }

  /** List one level under `prefix` a page at a time and `remove` each page until it lists empty. */
  async function drainListing(prefix: string, stuck: string, remove: (names: string[]) => Promise<void>) {
    let previous = '';
    for (;;) {
      const listed = await storage.from(BUCKET).list(prefix, { limit: 100 });
      if (listed.error) {
        if (missing(listed.error)) return;
        throw listed.error;
      }
      if (!listed.data?.length) return;
      const names = listed.data.map((file) => file.name);
      const page = names.join('\n');
      // A page that lists again after its remove would loop forever.
      if (page === previous) throw new Error(stuck);
      previous = page;
      await remove(names);
    }
  }
}

let store: ReturnType<typeof createSessionAttachmentStore> | undefined;
export function sessionAttachmentStore() {
  return (store ??= createSessionAttachmentStore(getSupabase().storage));
}
