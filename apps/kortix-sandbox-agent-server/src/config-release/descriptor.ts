import { z } from 'zod'

/**
 * The config release contract between the API and this daemon.
 *
 * Spec: docs/specs/config-releases.md, "Release descriptor" and "Workspace
 * report". The API decides which release a session runs. The daemon only
 * fetches, verifies, applies and reports.
 */

/** The existing `MAX_OPENCODE_CONFIG_ARCHIVE_BYTES`: 4 MiB. */
export const MAX_CONFIG_ARCHIVE_BYTES = 4 * 1024 * 1024

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

const DescriptorSchema = z
  .object({
    format: z.literal('config-release-v1'),
    release_id: z.string().regex(HEX64).nullable(),
    mode: z.enum(['follow-base', 'session-files']),
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
    reason: z.string().nullable(),
  })
  .superRefine((value, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message })
    if (value.mode === 'session-files') {
      if (value.archive !== null) issue('session-files mode carries no archive')
      if (value.files !== null) issue('session-files mode carries no files')
    }
    if (value.archive !== null) {
      if (value.release_id === null) issue('an archive needs a release_id')
      if (value.files === null) issue('an archive needs its files')
      if (value.config_dir === null) issue('an archive needs its config_dir')
      if (value.config_tree_id === null) issue('an archive needs its config_tree_id')
      if (value.source_commit === null) issue('an archive needs its source_commit')
      if (!/^\/v1\/projects\/[^/?#]+\/config-archives\/[0-9a-f]+(?:\?[^#]*)?$/.test(value.archive.url)) {
        issue('archive.url must be an API path under /v1/projects/<id>/config-archives/')
      }
    }
    if (value.files !== null) {
      const seen = new Set<string>()
      for (const [path] of value.files) {
        if (seen.has(path)) issue(`duplicate file ${path}`)
        seen.add(path)
      }
    }
    if ((value.compiled_governance === null) !== (value.compiled_governance_etag === null)) {
      issue('compiled_governance and compiled_governance_etag are both set or both null')
    }
  })

export type ConfigReleaseDescriptor = z.infer<typeof DescriptorSchema>
export type ConfigReleaseFile = z.infer<typeof FileEntry>

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

export type WorkspaceChangeStatus = 'modified' | 'added' | 'deleted' | 'untracked'

export interface WorkspaceChange {
  /** Repo-relative path, under `config_dir`. */
  path: string
  status: WorkspaceChangeStatus
  /** Git blob ID of the working-tree file; null when it is deleted. */
  blob: string | null
}

/**
 * What committed changes cover. `remote`: since the merge base with
 * `refs/remotes/origin/<base>`. `base-sha`: since `KORTIX_BASE_SHA`. `none`:
 * no base commit is available locally, so committed changes are NOT listed.
 */
export type WorkspaceCommittedScope = 'remote' | 'base-sha' | 'none'

export interface WorkspaceReport {
  head: string
  config_dir: string
  committed_scope: WorkspaceCommittedScope
  changed: WorkspaceChange[]
  /**
   * Working-tree text of `<config_dir>/package.json` when that file is in
   * `changed`; null when it is deleted; absent otherwise or above 256 KiB.
   * The API needs the text for its plugin-pin rule: an uncommitted or
   * unpushed blob is not in its mirror.
   */
  package_json?: string | null
}
