import { z } from 'zod'
import type { ProjectSnapshotDescriptor } from '@/lib/project-snapshot/contract'

/**
 * The config release contract between the API and this daemon.
 *
 * The API decides which release a session runs. The daemon only
 * fetches, verifies, applies and reports.
 */

/** The API's `MAX_CONFIG_ARCHIVE_BYTES` (apps/api/src/config-releases/release-tree.ts): 32 MiB. */
export const MAX_CONFIG_ARCHIVE_BYTES = 32 * 1024 * 1024

const HEX64 = /^[0-9a-f]{64}$/
/** A Git object ID: SHA-1 (40 hex) or SHA-256 (64 hex). */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const ETAG = /^[0-9a-f]{16}$/
const FILE_MODES = ['100644', '100755', '120000'] as const

/**
 * A literal repo-relative path. No absolute path, no `.` or `..` segment, no
 * empty segment, no control character. The same rule the config dir reader
 * applies, extended to file names inside the config dir.
 */
export function isPlainRelativePath(value: string): boolean {
  if (!value || value.startsWith('/') || value.startsWith('-')) return false
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return false
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

/** The config dir itself follows the stricter manifest rule. */
export function isPlainConfigDir(value: string): boolean {
  return (
    isPlainRelativePath(value) &&
    value.split('/').every((segment) => /^[\w .-]+$/.test(segment))
  )
}

const FileEntry = z.tuple([
  z.string().refine(isPlainRelativePath, 'file path must be a plain relative path'),
  z.enum(FILE_MODES),
  z.string().regex(OBJECT_ID, 'blob must be a Git object ID'),
])

/**
 * The project snapshot of `source_commit`: the commit's working tree plus a
 * blobless `.git`, as `tar.gz`, behind a presigned URL that takes no
 * credential. Its digest and size come from the API; the box keeps only the
 * listed files and verifies each against its blob ID. The shape is the
 * project snapshot's boot object (`lib/project-snapshot`), checked at compile
 * time so the two cannot drift.
 */
const SnapshotRef = z.object({
  url: z.string().regex(/^https?:\/\//, 'snapshot.url must be an http(s) URL'),
  sha256: z.string().regex(HEX64),
  bytes: z.number().int().positive(),
  entries: z.number().int().nonnegative(),
  expires_at: z.string(),
}) satisfies z.ZodType<ProjectSnapshotDescriptor['tree']>

/** What this daemon asks the API for. A v3 tree release may come with no archive. */
export const ACCEPTED_FORMATS = ['config-release-v3'] as const

const DescriptorSchema = z
  .object({
    /**
     * v2: a tree release always carries the archive. v3: a tree over the
     * API's archive cap has `archive: null`, and the box builds the release
     * from its own checkout or from `snapshot`.
     */
    format: z.enum(['config-release-v2', 'config-release-v3']),
    release_id: z.string().regex(HEX64).nullable(),
    mode: z.literal('follow-base'),
    source_commit: z.string().regex(OBJECT_ID).nullable(),
    config_dir: z.string().refine(isPlainConfigDir, 'config_dir must be a plain relative path').nullable(),
    config_tree_id: z.string().regex(OBJECT_ID).nullable(),
    archive: z
      .object({
        url: z.string(),
        bytes: z.number().int().positive().max(MAX_CONFIG_ARCHIVE_BYTES),
      })
      .nullable(),
    files: z.array(FileEntry).nullable(),
    compiled_governance: z.string().nullable(),
    compiled_governance_etag: z.string().regex(ETAG).nullable(),
    /**
     * The session's agent was re-pointed to the project's declared default,
     * because the manifest no longer declares its own (PLAN-one-boot-path C10).
     * The API decides it and writes `reason` as a finished sentence; the daemon
     * only puts that sentence in front of the session, verbatim.
     */
    agent_repoint: z
      .object({
        from: z.string().nullable(),
        to: z.string().nullable(),
        applied: z.boolean(),
        reason: z.string().nullable(),
      })
      .nullish()
      .transform((value) => value ?? null),
    reason: z.string().nullable(),
    snapshot: SnapshotRef.nullish().transform((value) => value ?? null),
  })
  .superRefine((value, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message })
    if (value.archive !== null) {
      if (value.release_id === null) issue('an archive needs a release_id')
      if (value.files === null) issue('an archive needs its files')
      if (value.config_tree_id === null) issue('an archive needs its config_tree_id')
      if (value.source_commit === null) issue('an archive needs its source_commit')
      if (!/^\/v1\/projects\/[^/?#]+\/config-archives\/[0-9a-f]+(?:\?[^#]*)?$/.test(value.archive.url)) {
        issue('archive.url must be an API path under /v1/projects/<id>/config-archives/')
      }
    }
    if (value.files !== null) {
      // A tree release: the box builds it from the files, whatever carries them.
      if (value.release_id === null) issue('files need a release_id')
      if (value.config_tree_id === null) issue('files need their config_tree_id')
      if (value.source_commit === null) issue('files need their source_commit')
      if (value.format === 'config-release-v2' && value.archive === null) issue('a v2 tree release needs its archive')
      const seen = new Set<string>()
      for (const [path] of value.files) {
        if (seen.has(path)) issue(`duplicate file ${path}`)
        seen.add(path)
      }
    }
    if (value.snapshot !== null && value.files === null) issue('a snapshot needs its files')
    if ((value.compiled_governance === null) !== (value.compiled_governance_etag === null)) {
      issue('compiled_governance and compiled_governance_etag are both set or both null')
    }
  })

export type ConfigReleaseDescriptor = z.infer<typeof DescriptorSchema>
export type ConfigReleaseFile = z.infer<typeof FileEntry>
export type ConfigReleaseSnapshot = z.infer<typeof SnapshotRef>

/** Parse an untrusted JSON value. Throws with every validation issue. */
export function parseConfigReleaseDescriptor(value: unknown): ConfigReleaseDescriptor {
  const parsed = DescriptorSchema.safeParse(value)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ')
    throw new Error(`invalid config release descriptor: ${detail}`)
  }
  return parsed.data
}
