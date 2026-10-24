/**
 * Memory pages (`project_channels`): `/v1/projects/:projectId/memory/*`.
 *
 * Postgres holds the pages (`kortix.memory_*`). A layer is the project's
 * Company layer, one channel's layer or one DM's layer. A page has one of 4
 * types; a `note` is a Remember-box sentence an agent has not filed yet.
 * People read and edit pages over REST; an agent writes with the `remember`
 * platform tool (kortixd) and reads a read-only copy under `MEMORY_COPY_DIR`
 * (`./sandbox-layout`), refreshed from the layer export.
 *
 * Caps the schemas cannot express with a 400 are the API's: the body byte cap
 * (413 `page_too_large`), pages per layer (409 `page_limit`) and secrets
 * (422 `secret_detected`).
 */
import { z } from 'zod';

/** The caps of `apps/api/src/memory/limits.ts`. `*_chars` are JS string lengths (UTF-16 units): `limits.ts` uses `.length` too. */
export const MEMORY_LIMITS = {
  title_chars: 120,
  summary_chars: 200,
  note_chars: 1000,
  body_bytes: 8192,
  related: 10,
  pages_per_layer: 200,
  source_label_chars: 80,
  url_chars: 2048,
} as const;

export const MEMORY_LAYER_SCOPES = ['company', 'channel', 'dm'] as const;
export const MemoryLayerScopeSchema = z.enum(MEMORY_LAYER_SCOPES);
export type MemoryLayerScope = z.infer<typeof MemoryLayerScopeSchema>;

/** The 4 types a person or agent files a page as. */
export const MEMORY_FILED_PAGE_TYPES = ['people', 'decisions', 'workstreams', 'playbooks'] as const;
export const MemoryFiledPageTypeSchema = z.enum(MEMORY_FILED_PAGE_TYPES);
export type MemoryFiledPageType = z.infer<typeof MemoryFiledPageTypeSchema>;

/** Every page type: the 4 filed types and `note`. */
export const MEMORY_PAGE_TYPES = [...MEMORY_FILED_PAGE_TYPES, 'note'] as const;
export const MemoryPageTypeSchema = z.enum(MEMORY_PAGE_TYPES);
export type MemoryPageType = z.infer<typeof MemoryPageTypeSchema>;

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

/** The folders of the read-only copy, one per layer scope. */
export const MEMORY_COPY_DIRS = ['company', 'channel', 'personal'] as const;
export const MemoryCopyDirSchema = z.enum(MEMORY_COPY_DIRS);
export type MemoryCopyDir = z.infer<typeof MemoryCopyDirSchema>;
export const MEMORY_SCOPE_COPY_DIR: Record<MemoryLayerScope, MemoryCopyDir> = {
  company: 'company',
  channel: 'channel',
  dm: 'personal',
};

/** A layer in a route path: `company`, or the space id of a channel or DM. */
export const MemoryLayerKeySchema = z.union([z.literal('company'), z.string().uuid()]);
export type MemoryLayerKey = z.infer<typeof MemoryLayerKeySchema>;

/** `memory_layers.version` (a bigint) as decimal text. */
const LayerVersionSchema = z.string().regex(/^(0|[1-9]\d*)$/);

/** `memory_pages.updated_by_kind` null serializes as `kind: 'system'`. */
export const MemoryAuthorSchema = z
  .object({
    kind: z.enum(['person', 'agent', 'system']),
    /** The person, or the person an agent wrote for. */
    user_id: z.string().nullable(),
    /** Display name or email; null when unknown. */
    name: z.string().nullable(),
    /** The agent name, for `kind: agent`. */
    agent: z.string().nullable(),
  })
  .strict();
export type MemoryAuthor = z.infer<typeof MemoryAuthorSchema>;

/** The thread a change came from; `label` is read from the session at read time. Null (where nullable) when the thread is gone. */
export const MemoryThreadRefSchema = z.object({ session_id: z.string(), label: z.string() }).strict();
export type MemoryThreadRef = z.infer<typeof MemoryThreadRefSchema>;

/** A numbered source of a page; the body cites it as the token ⟦n⟧. */
export const MemorySourceSchema = z
  .object({
    number: z.number().int().positive(),
    kind: MemorySourceKindSchema,
    session_id: z.string().nullable(),
    message_id: z.string().nullable(),
    label: z.string(),
    /** `outside` sources only. */
    url: z.string().nullable(),
    /** Where the source thread lives, so a host can build its link; null when the thread or its space is gone. */
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
    layer_id: z.string(),
    scope: MemoryLayerScopeSchema,
    /** Null for the Company layer. */
    space_id: z.string().nullable(),
    /** "Company", "#marketing", or the DM's agent name. */
    name: z.string(),
    /** Live pages per type; `unconfirmed` and `trash` count across types. */
    counts: z
      .object({
        people: z.number().int(),
        decisions: z.number().int(),
        workstreams: z.number().int(),
        playbooks: z.number().int(),
        note: z.number().int(),
        unconfirmed: z.number().int(),
        trash: z.number().int(),
      })
      .strict(),
    /** An archived channel's layer: every write answers 409 `layer_read_only`. */
    read_only: z.boolean(),
    can_write: z.boolean(),
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
};

export const MemoryPageSummarySchema = z.object(memoryPageSummaryShape).strict();
export type MemoryPageSummary = z.infer<typeof MemoryPageSummarySchema>;

export const MemoryPageListSchema = z.object({ pages: z.array(MemoryPageSummarySchema) }).strict();
export type MemoryPageList = z.infer<typeof MemoryPageListSchema>;

export const MemoryPageSchema = z
  .object({
    ...memoryPageSummaryShape,
    /** Markdown; `## ` headings make sections, ⟦n⟧ cites `sources[n]`. */
    body: z.string(),
    sources: z.array(MemorySourceSchema),
    related: z.array(z.object({ page_id: z.string(), title: z.string() }).strict()),
    /** Send it back as `base_version` on update. */
    version_no: z.number().int(),
    can_edit: z.boolean(),
    can_delete: z.boolean(),
  })
  .strict();
export type MemoryPage = z.infer<typeof MemoryPageSchema>;

/** One row of Recent changes. */
export const MemoryChangeSchema = z
  .object({
    version_id: z.string(),
    /** Shared by every row one change wrote (both pages of a `file_note`); Undo reverts them all. */
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

/** `next`: the `before` value of the next page; null on the last page. */
export const MemoryChangeListSchema = z
  .object({ changes: z.array(MemoryChangeSchema), next: z.string().nullable() })
  .strict();
export type MemoryChangeList = z.infer<typeof MemoryChangeListSchema>;

/** One entry of a page's history: the page as it was after that change. */
export const MemoryVersionSchema = z
  .object({
    version_id: z.string(),
    change_id: z.string(),
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

/** `next`: the `before` value of the next page; null on the last page. */
export const MemoryVersionListSchema = z
  .object({ versions: z.array(MemoryVersionSchema), next: z.string().nullable() })
  .strict();

/** `DELETE …/pages/:pageId`: the page went to the trash in version `version_id`. */
export const MemoryDeleteResultSchema = z.object({ ok: z.literal(true), version_id: z.string() }).strict();
export type MemoryDeleteResult = z.infer<typeof MemoryDeleteResultSchema>;

/**
 * `POST …/versions/:versionId/undo`: every live page the undo touched (both
 * pages of a `file_note`); empty when the undo removed a page it had created.
 */
export const MemoryUndoResultSchema = z.object({ pages: z.array(MemoryPageSchema) }).strict();
export type MemoryUndoResult = z.infer<typeof MemoryUndoResultSchema>;
export type MemoryVersionList = z.infer<typeof MemoryVersionListSchema>;

const TitleInput = z.string().trim().min(1).max(MEMORY_LIMITS.title_chars);
const SummaryInput = z.string().trim().max(MEMORY_LIMITS.summary_chars).regex(/^[^\r\n]*$/, 'summary is one line');
/** The byte cap (413 `page_too_large`) is the API's. */
const BodyInput = z.string();
const RelatedInput = z.array(z.string().uuid()).max(MEMORY_LIMITS.related);

export const MemoryPageCreateInputSchema = z
  .object({
    type: MemoryFiledPageTypeSchema,
    title: TitleInput,
    summary: SummaryInput.optional(),
    body: BodyInput.optional(),
    related: RelatedInput.optional(),
  })
  .strict();
export type MemoryPageCreateInput = z.infer<typeof MemoryPageCreateInputSchema>;

export const MemoryPageUpdateInputSchema = z
  .object({
    /** The `version_no` the edit started from; another version answers 409. */
    base_version: z.number().int().positive(),
    title: TitleInput.optional(),
    type: MemoryFiledPageTypeSchema.optional(),
    summary: SummaryInput.optional(),
    body: BodyInput.optional(),
    related: RelatedInput.optional(),
  })
  .strict();
export type MemoryPageUpdateInput = z.infer<typeof MemoryPageUpdateInputSchema>;

/** A Remember-box sentence: saved as a `note` page. */
export const MemoryNoteInputSchema = z
  .object({
    text: z.string().trim().min(1).max(MEMORY_LIMITS.note_chars),
    source_session_id: z.string().min(1).optional(),
    source_message_id: z.string().min(1).optional(),
  })
  .strict();
export type MemoryNoteInput = z.infer<typeof MemoryNoteInputSchema>;

export const MemoryRestoreInputSchema = z.object({ version_id: z.string().uuid() }).strict();
export type MemoryRestoreInput = z.infer<typeof MemoryRestoreInputSchema>;

/**
 * `POST /memory/remember`, the body kortixd's `remember` tool sends
 * (apps/kortix-sandbox-agent-server/src/services/tools/platform/remember.ts).
 * Exactly one of `fact` (one line added, under `section` when given) and
 * `body` (the whole page). `layer` defaults to the thread's own layer.
 */
export const MemoryRememberInputSchema = z
  .object({
    title: TitleInput,
    type: MemoryFiledPageTypeSchema,
    summary: SummaryInput.optional(),
    fact: z.string().trim().min(1).optional(),
    body: z.string().trim().min(1).optional(),
    section: z.string().trim().min(1).max(MEMORY_LIMITS.title_chars).optional(),
    layer: MemoryLayerScopeSchema.optional(),
    from_note_id: z.string().uuid().optional(),
    /** Where a fact from outside the thread came from: it waits for a person (`unconfirmed`, or a "(to confirm)" page for an addition to a confirmed page). */
    outside: z
      .object({
        label: z.string().trim().min(1).max(MEMORY_LIMITS.source_label_chars),
        url: z.string().trim().max(MEMORY_LIMITS.url_chars).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((input) => (input.fact === undefined) !== (input.body === undefined), {
    message: 'give exactly one of fact or body',
    path: ['fact'],
  });
export type MemoryRememberInput = z.infer<typeof MemoryRememberInputSchema>;

export const MemoryRememberResultSchema = z
  .object({
    saved: z.literal(true),
    page_id: z.string(),
    version_id: z.string(),
    /** kortixd refreshes the copy of this layer at once (`layer_id`, `version`, `scope`). */
    layer: z
      .object({
        layer_id: z.string(),
        version: LayerVersionSchema,
        scope: MemoryLayerScopeSchema,
        name: z.string(),
        key: MemoryLayerKeySchema,
      })
      .strict(),
    title: z.string(),
    status: MemoryPageStatusSchema,
    /** A new page was made. */
    created: z.boolean(),
    /** The fact went into an existing page. */
    merged: z.boolean(),
    /** The page's file in the read-only copy, e.g. `/opt/kortix/memory/channel/people/priya.md`; null when the page is not in the copy (unconfirmed). */
    copy_path: z.string().nullable(),
  })
  .strict();
export type MemoryRememberResult = z.infer<typeof MemoryRememberResultSchema>;

/**
 * `GET /memory/layers/:layerId/export` (session token): every file of the
 * layer's read-only copy, rendered by the API. kortixd writes `index` to
 * `INDEX.md` and each page's `markdown` (YAML header and body, ⟦n⟧ resolved to
 * `[label]`) to `<type folder>/<slug>.md`.
 */
export const MemoryLayerExportSchema = z
  .object({
    layer_id: z.string(),
    version: LayerVersionSchema,
    dir: MemoryCopyDirSchema,
    index: z.string(),
    pages: z.array(
      z
        .object({
          page_id: z.string(),
          type: MemoryPageTypeSchema,
          /** Unique per layer: the ASCII title slug, else `page-<first 8 of page_id>`; on a clash, suffix `-<first 6 of page_id>`. */
          slug: z.string().regex(/^[a-z0-9-]+$/),
          markdown: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type MemoryLayerExport = z.infer<typeof MemoryLayerExportSchema>;

/**
 * `memory_layers` on the Kortix prompt body at turn start: the thread's layers
 * and their versions. kortixd rejects the whole prompt on a value this schema
 * rejects, so the turn hook `safeParse`s and forwards the body unchanged on failure.
 */
export const MemoryTurnLayersSchema = z
  .array(z.object({ layer_id: z.string().min(1), version: LayerVersionSchema, dir: MemoryCopyDirSchema }).strict())
  .max(MEMORY_COPY_DIRS.length)
  .refine((layers) => new Set(layers.map((layer) => layer.dir)).size === layers.length, 'each dir once');
export type MemoryTurnLayers = z.infer<typeof MemoryTurnLayersSchema>;

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
    /** Up to ~160 characters of the body around the first match, source tokens removed. */
    snippet: z.string(),
    status: MemoryPageStatusSchema,
  })
  .strict();
export type MemorySearchHit = z.infer<typeof MemorySearchHitSchema>;

export const MemorySearchResultSchema = z.object({ hits: z.array(MemorySearchHitSchema) }).strict();
export type MemorySearchResult = z.infer<typeof MemorySearchResultSchema>;

/**
 * `GET /sessions/:sessionId/memory-usage`: the pages listed to the thread's
 * agent at its first turn ("Used memory"). Pages deleted since are left out;
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
