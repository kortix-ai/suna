/**
 * Memory: `/v1/projects/:projectId/memory/*`.
 *
 * Memory is Markdown files in the project's Drive. A layer is one folder:
 * Company (`/Company/Memory`), one channel (`/Company/Channels/<slug>/Memory`)
 * or one DM (the owner's `/Users/<person>/Memory`, its agent folder
 * `Memory/<agent>` first). A page is one `.md` file; its type comes from
 * front-matter `type:`, else its first folder (`people/`, `decisions/`,
 * `workstreams/`, `playbooks/`), else `Notes.md` = `note`, else `other`.
 * People read and edit pages over REST; agents read and write the same files
 * through their `/drives` mounts. Nothing is copied.
 *
 * Caps the schemas cannot express with a 400 are the API's: the body byte cap
 * (413 `page_too_large`) and secrets (422 `secret_detected`).
 */
import { z } from 'zod';

/** The caps of `apps/api/src/memory/files.ts`. `*_chars` are JS string lengths (UTF-16 units). `pages_per_layer` caps a list, not a layer. */
export const MEMORY_LIMITS = {
  title_chars: 120,
  summary_chars: 200,
  note_chars: 1000,
  body_bytes: 262_144,
  related: 10,
  pages_per_layer: 500,
  source_label_chars: 80,
  url_chars: 2048,
} as const;

export const MEMORY_LAYER_SCOPES = ['company', 'channel', 'dm'] as const;
export const MemoryLayerScopeSchema = z.enum(MEMORY_LAYER_SCOPES);
export type MemoryLayerScope = z.infer<typeof MemoryLayerScopeSchema>;

/** The 4 typed folders a page can live in. */
export const MEMORY_FILED_PAGE_TYPES = ['people', 'decisions', 'workstreams', 'playbooks'] as const;
export const MemoryFiledPageTypeSchema = z.enum(MEMORY_FILED_PAGE_TYPES);
export type MemoryFiledPageType = z.infer<typeof MemoryFiledPageTypeSchema>;

/** Every page type: the 4 filed types, `note` (a `Notes.md`) and `other` (any other Markdown file). */
export const MEMORY_PAGE_TYPES = [...MEMORY_FILED_PAGE_TYPES, 'note', 'other'] as const;
export const MemoryPageTypeSchema = z.enum(MEMORY_PAGE_TYPES);
export type MemoryPageType = z.infer<typeof MemoryPageTypeSchema>;

/** The types a person creates a page as: a filed type, or `other` (a file at the layer root). */
export const MemoryCreatePageTypeSchema = z.enum([...MEMORY_FILED_PAGE_TYPES, 'other']);
export type MemoryCreatePageType = z.infer<typeof MemoryCreatePageTypeSchema>;

/** Always `confirmed`: files have no pending state. Kept for the response shape. */
export const MemoryPageStatusSchema = z.enum(['confirmed', 'unconfirmed']);
export type MemoryPageStatus = z.infer<typeof MemoryPageStatusSchema>;

export const MemoryChangeOpSchema = z.enum([
  'create',
  'update',
  'append',
  'delete',
  'restore',
  'undo',
  'confirm',
  'file_note',
  'import',
]);
export type MemoryChangeOp = z.infer<typeof MemoryChangeOpSchema>;

export const MemorySourceKindSchema = z.enum(['thread', 'person', 'outside', 'import']);
export type MemorySourceKind = z.infer<typeof MemorySourceKindSchema>;

/** A layer in a route path: `company`, or the space id of a channel or DM. */
export const MemoryLayerKeySchema = z.union([z.literal('company'), z.string().uuid()]);
export type MemoryLayerKey = z.infer<typeof MemoryLayerKeySchema>;

/** Who last changed a page: front-matter `updated_by`, else `system`. */
export const MemoryAuthorSchema = z
  .object({
    kind: z.enum(['person', 'agent', 'system']),
    /** Always null for files: front-matter names people by name. */
    user_id: z.string().nullable(),
    /** Display name; null when unknown. */
    name: z.string().nullable(),
    /** The agent name, for `kind: agent`. */
    agent: z.string().nullable(),
  })
  .strict();
export type MemoryAuthor = z.infer<typeof MemoryAuthorSchema>;

/** The thread a change came from. Always null for files; kept for the response shape. */
export const MemoryThreadRefSchema = z.object({ session_id: z.string(), label: z.string() }).strict();
export type MemoryThreadRef = z.infer<typeof MemoryThreadRefSchema>;

/** A numbered source of a page, from front-matter `sources:` (1-based, in file order). */
export const MemorySourceSchema = z
  .object({
    number: z.number().int().positive(),
    kind: MemorySourceKindSchema,
    session_id: z.string().nullable(),
    message_id: z.string().nullable(),
    label: z.string(),
    url: z.string().nullable(),
    /** Always null for files. */
    thread_href_hint: z
      .discriminatedUnion('space_kind', [
        z.object({ space_kind: z.literal('channel'), slug: z.string() }).strict(),
        z.object({ space_kind: z.literal('dm'), agent: z.string() }).strict(),
      ])
      .nullable(),
  })
  .strict();
export type MemorySource = z.infer<typeof MemorySourceSchema>;

export const MemoryLayerSchema = z
  .object({
    /** The layer key (`company` or the space id). */
    layer_id: z.string(),
    scope: MemoryLayerScopeSchema,
    /** Null for the Company layer. */
    space_id: z.string().nullable(),
    /** "Company", "#marketing", or the DM's agent name. */
    name: z.string(),
    /** Pages per type. `unconfirmed` and `trash` are always 0 (no pending state, no trash). */
    counts: z
      .object({
        people: z.number().int(),
        decisions: z.number().int(),
        workstreams: z.number().int(),
        playbooks: z.number().int(),
        note: z.number().int(),
        other: z.number().int(),
        unconfirmed: z.number().int(),
        trash: z.number().int(),
      })
      .strict(),
    /** An archived channel's layer: every write answers 409 `layer_read_only`. */
    read_only: z.boolean(),
    can_write: z.boolean(),
    /** The layer's folder, a Drive path (`/Company/Memory`). */
    folder: z.string(),
    /** A DM layer's agent folder (`/Users/<person>/Memory/<agent>`); null for others. */
    agent_folder: z.string().nullable(),
    drive_id: z.string(),
    /** Files under the folder that are not pages (images, PDFs, …): "Open in Files". */
    other_files: z.number().int(),
  })
  .strict();
export type MemoryLayer = z.infer<typeof MemoryLayerSchema>;

export const MemoryLayerListSchema = z.object({ layers: z.array(MemoryLayerSchema) }).strict();
export type MemoryLayerList = z.infer<typeof MemoryLayerListSchema>;

const memoryPageSummaryShape = {
  page_id: z.string(),
  layer_id: z.string(),
  type: MemoryPageTypeSchema,
  title: z.string(),
  summary: z.string(),
  status: MemoryPageStatusSchema,
  updated_at: z.string(),
  updated_by: MemoryAuthorSchema,
  updated_source: MemoryThreadRefSchema.nullable(),
  /** The file, a Drive path. */
  path: z.string(),
};

export const MemoryPageSummarySchema = z.object(memoryPageSummaryShape).strict();
export type MemoryPageSummary = z.infer<typeof MemoryPageSummarySchema>;

/** `truncated`: the layer has more than `MEMORY_LIMITS.pages_per_layer` pages; the newest are listed. */
export const MemoryPageListSchema = z.object({ pages: z.array(MemoryPageSummarySchema), truncated: z.boolean() }).strict();
export type MemoryPageList = z.infer<typeof MemoryPageListSchema>;

export const MemoryPageSchema = z
  .object({
    ...memoryPageSummaryShape,
    /** The file's Markdown without front-matter and without its first `# ` heading. */
    body: z.string(),
    sources: z.array(MemorySourceSchema),
    related: z.array(z.object({ page_id: z.string(), title: z.string() }).strict()),
    /** The file's mtime in ms. Send it back as `base_version` on update. */
    version_no: z.number().int(),
    can_edit: z.boolean(),
    can_delete: z.boolean(),
  })
  .strict();
export type MemoryPage = z.infer<typeof MemoryPageSchema>;

/** One row of Recent changes: a recently changed file. */
export const MemoryChangeSchema = z
  .object({
    version_id: z.string(),
    /** The page id. */
    change_id: z.string(),
    page_id: z.string(),
    page_title: z.string(),
    op: MemoryChangeOpSchema,
    author: MemoryAuthorSchema,
    source: MemoryThreadRefSchema.nullable(),
    created_at: z.string(),
    undone: z.boolean(),
    can_undo: z.boolean(),
  })
  .strict();
export type MemoryChange = z.infer<typeof MemoryChangeSchema>;

/** `next`: always null (one page of the newest changes). */
export const MemoryChangeListSchema = z
  .object({ changes: z.array(MemoryChangeSchema), next: z.string().nullable() })
  .strict();
export type MemoryChangeList = z.infer<typeof MemoryChangeListSchema>;

/** One entry of a page's history: the file as it was at one Drive commit. */
export const MemoryVersionSchema = z
  .object({
    version_id: z.string(),
    change_id: z.string(),
    /** The commit time in ms. */
    version_no: z.number().int(),
    op: MemoryChangeOpSchema,
    author: MemoryAuthorSchema,
    source: MemoryThreadRefSchema.nullable(),
    created_at: z.string(),
    undone: z.boolean(),
    can_undo: z.boolean(),
    snapshot: z
      .object({
        type: MemoryPageTypeSchema,
        title: z.string(),
        summary: z.string(),
        body: z.string(),
        status: MemoryPageStatusSchema,
        related: z.array(z.string()),
        deleted: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type MemoryVersion = z.infer<typeof MemoryVersionSchema>;

/** `next`: always null. Older versions are in Files → Versions. */
export const MemoryVersionListSchema = z
  .object({ versions: z.array(MemoryVersionSchema), next: z.string().nullable() })
  .strict();
export type MemoryVersionList = z.infer<typeof MemoryVersionListSchema>;

/** `DELETE …/pages/:pageId`: the file is deleted for good. `version_id` is the deleted page id; it is not undoable. */
export const MemoryDeleteResultSchema = z.object({ ok: z.literal(true), version_id: z.string() }).strict();
export type MemoryDeleteResult = z.infer<typeof MemoryDeleteResultSchema>;

/** `POST …/versions/:versionId/undo`: the page after the undo; empty when the undo deleted a file the version created. */
export const MemoryUndoResultSchema = z.object({ pages: z.array(MemoryPageSchema) }).strict();
export type MemoryUndoResult = z.infer<typeof MemoryUndoResultSchema>;

const TitleInput = z.string().trim().min(1).max(MEMORY_LIMITS.title_chars);
const SummaryInput = z.string().trim().max(MEMORY_LIMITS.summary_chars).regex(/^[^\r\n]*$/, 'summary is one line');
/** The byte cap (413 `page_too_large`) is the API's. */
const BodyInput = z.string();
/** Page ids of the same layer. */
const RelatedInput = z.array(z.string().min(1)).max(MEMORY_LIMITS.related);

export const MemoryPageCreateInputSchema = z
  .object({
    type: MemoryCreatePageTypeSchema,
    title: TitleInput,
    summary: SummaryInput.optional(),
    body: BodyInput.optional(),
    related: RelatedInput.optional(),
    /** DM layer only: `true` (default) writes into the agent folder, `false` into the person's shared Memory folder. */
    agent_folder: z.boolean().optional(),
  })
  .strict();
export type MemoryPageCreateInput = z.infer<typeof MemoryPageCreateInputSchema>;

/** The UI edits the body only; front-matter and the `# ` heading are kept. */
export const MemoryPageUpdateInputSchema = z
  .object({
    /** The `version_no` the edit started from; another version answers 409 `version_conflict`. */
    base_version: z.number().int().positive(),
    body: BodyInput,
  })
  .strict();
export type MemoryPageUpdateInput = z.infer<typeof MemoryPageUpdateInputSchema>;

/** A Remember-box sentence: appended to the layer's `Notes.md`. */
export const MemoryNoteInputSchema = z
  .object({
    text: z.string().trim().min(1).max(MEMORY_LIMITS.note_chars),
    source_session_id: z.string().min(1).optional(),
    source_message_id: z.string().min(1).optional(),
  })
  .strict();
export type MemoryNoteInput = z.infer<typeof MemoryNoteInputSchema>;

/** kortixd's cap on the per-turn `system` text of the Kortix prompt body; the turn hook never sends more. */
export const MEMORY_TURN_SYSTEM_MAX_CHARS = 16_000;

/** `GET /memory/search`: `q` 2–200 characters, at most 20 hits. */
export const MEMORY_SEARCH_LIMITS = { q_min: 2, q_max: 200, limit: 20 } as const;

export const MemorySearchHitSchema = z
  .object({
    page_id: z.string(),
    layer_key: MemoryLayerKeySchema,
    layer_name: z.string(),
    scope: MemoryLayerScopeSchema,
    type: MemoryPageTypeSchema,
    title: z.string(),
    summary: z.string(),
    /** Up to ~160 characters of the body around the first match. */
    snippet: z.string(),
    status: MemoryPageStatusSchema,
  })
  .strict();
export type MemorySearchHit = z.infer<typeof MemorySearchHitSchema>;

export const MemorySearchResultSchema = z.object({ hits: z.array(MemorySearchHitSchema) }).strict();
export type MemorySearchResult = z.infer<typeof MemorySearchResultSchema>;

/**
 * `GET /sessions/:sessionId/memory-usage`: the pages listed to the thread's
 * agent at its first turn ("Used memory"). Files deleted since are left out;
 * `loaded_at` is null before the first turn.
 */
export const MemoryUsageSchema = z
  .object({
    loaded_at: z.string().nullable(),
    layers: z.array(
      z
        .object({
          layer_key: MemoryLayerKeySchema,
          scope: MemoryLayerScopeSchema,
          name: z.string(),
          pages: z.array(z.object({ page_id: z.string(), type: MemoryPageTypeSchema, title: z.string() }).strict()),
        })
        .strict(),
    ),
  })
  .strict();
export type MemoryUsage = z.infer<typeof MemoryUsageSchema>;
