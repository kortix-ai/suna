/**
 * kortix_change_requests: the project's change requests, a proposed change to
 * the project files that waits for someone to approve it. List the open ones,
 * read one (its summary, how many files it changes, and whether it can merge),
 * merge one once the person agreed, or close one. An agent with the project
 * files opens a change request; this tool never opens one.
 * A My Kortix platform tool (`platform.ts`): every action is one or two
 * `kortix cr …` commands.
 */
import { capRows, cliArgProblem, cliJson, cliRun, fail, memberName, ok, projectHref, projectRoster, sessionHref, type PlatformToolContext } from './platform'

const TOOL = 'kortix_change_requests' as const
const ACTIONS = ['list', 'get', 'merge', 'close'] as const
const STATUSES = ['open', 'merged', 'closed', 'all'] as const

/** One change request as `kortix cr ls --json` and `kortix cr show --json` print it. */
interface ChangeRequestRow {
  cr_id?: string
  number?: number
  title?: string
  description?: string | null
  status?: string
  base_ref?: string
  head_ref?: string
  origin_session_id?: string | null
  created_by?: string | null
  created_at?: string
  merged_at?: string | null
  closed_at?: string | null
}

/** `kortix cr show --json`: the request, and for an open one whether it can merge. */
interface ShowAnswer {
  change_request?: ChangeRequestRow
  merge_preview?: { can_merge?: boolean; can_fast_forward?: boolean; conflicts?: string[]; is_up_to_date?: boolean } | null
}

/** The Review tab with this request open (`?id=cr:<cr_id>`, the Review Center's item id). */
function reviewHref(context: PlatformToolContext, cr?: ChangeRequestRow): string {
  return projectHref(context.env, cr?.cr_id ? `/review?id=${encodeURIComponent(`cr:${cr.cr_id}`)}` : '/review')
}

/** `refs/heads/main` → `main`. */
function branch(ref: string | undefined): string | null {
  return ref ? ref.replace(/^refs\/heads\//, '') : null
}

const label = (cr: ChangeRequestRow) => `#${cr.number ?? '?'}`

/** User id → display name, from the project's members; empty when the person may not read them. */
async function authors(context: PlatformToolContext): Promise<Map<string, string>> {
  const roster = (await projectRoster(context)) ?? []
  return new Map(roster.filter((m) => m.user_id).map((m) => [m.user_id!, memberName(m)]))
}

function summary(cr: ChangeRequestRow, names: Map<string, string>) {
  return {
    number: cr.number ?? null,
    cr_id: cr.cr_id ?? null,
    title: cr.title ?? '',
    author: (cr.created_by && names.get(cr.created_by)) || null,
    status: cr.status ?? null,
    from: branch(cr.head_ref),
    into: branch(cr.base_ref),
    session_id: cr.origin_session_id ?? null,
    opened_at: cr.created_at ?? null,
  }
}

async function list(status: string, context: PlatformToolContext) {
  const read = await cliJson<{ change_requests?: ChangeRequestRow[] }>(['cr', 'ls', `--status=${status}`, '--json'], context)
  if ('error' in read) return fail(TOOL, 'list', 'Could not list the change requests', read.error, context)
  const rows = Array.isArray(read.value.change_requests) ? read.value.change_requests : []
  const names = rows.length > 0 ? await authors(context) : new Map<string, string>()
  const word = status === 'all' ? '' : `${status} `
  return ok(
    TOOL,
    'list',
    {
      title: rows.length === 1 ? `1 ${word}change request` : `${rows.length} ${word}change requests`,
      rows: capRows(
        rows.map((cr) => {
          const author = summary(cr, names).author
          return { title: `${label(cr)} ${cr.title ?? ''}`.trim(), ...(author ? { detail: author } : {}), ...(cr.status ? { badge: cr.status } : {}), href: reviewHref(context, cr) }
        }),
      ),
      links: [{ label: 'Review', href: reviewHref(context) }],
    },
    { change_requests: rows.map((cr) => summary(cr, names)) },
  )
}

/** One request, or the failed result to return. */
async function show(id: string, action: string, context: PlatformToolContext) {
  const read = await cliJson<ShowAnswer>(['cr', 'show', id, '--json'], context)
  if ('error' in read) return { failed: await fail(TOOL, action, `Could not read change request ${id}`, read.error, context) }
  const cr = read.value.change_request
  if (!cr) return { failed: await fail(TOOL, action, `Could not read change request ${id}`, { kind: 'failed', message: 'The command answered with no change request.' }, context) }
  return { cr, preview: read.value.merge_preview ?? null }
}

/** Files, additions and deletions in a unified diff. */
function patchStats(patch: string): { files: number; additions: number; deletions: number } {
  let files = 0
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) files += 1
    else if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
  }
  return { files, additions, deletions }
}

/** Whether an open request can merge, as one plain line. */
function mergeLine(preview: ShowAnswer['merge_preview']): string | null {
  if (!preview) return null
  if (preview.is_up_to_date) return 'Nothing to merge: the change is already in.'
  if (preview.can_merge) return 'Ready to merge, no conflicts.'
  const conflicts = preview.conflicts ?? []
  return conflicts.length > 0 ? `Cannot merge: ${conflicts.length === 1 ? '1 file conflicts' : `${conflicts.length} files conflict`}.` : 'Cannot merge yet.'
}

async function get(id: string, context: PlatformToolContext) {
  const read = await show(id, 'get', context)
  if ('failed' in read) return read.failed
  const { cr, preview } = read
  const diff = await cliJson<{ patch?: string }>(['cr', 'diff', id, '--json'], context)
  const stats = 'error' in diff ? null : patchStats(typeof diff.value.patch === 'string' ? diff.value.patch : '')
  const names = await authors(context)
  const base = summary(cr, names)
  const description = (cr.description ?? '').trim()
  const merge = cr.status === 'open' ? mergeLine(preview) : null
  return ok(
    TOOL,
    'get',
    {
      title: `${label(cr)} ${cr.title ?? ''}`.trim(),
      ...(description ? { subtitle: description.length > 280 ? `${description.slice(0, 277)}…` : description } : {}),
      rows: [
        ...(stats ? [{ title: stats.files === 1 ? '1 file changed' : `${stats.files} files changed`, detail: `+${stats.additions} −${stats.deletions}` }] : []),
        ...(merge ? [{ title: merge, ...(preview?.can_merge ? { badge: 'ready' } : preview?.is_up_to_date ? {} : { badge: 'blocked' }) }] : []),
        ...(base.author ? [{ title: `Opened by ${base.author}` }] : []),
        { title: 'Status', badge: cr.status ?? 'unknown' },
      ],
      links: [
        { label: 'Review', href: reviewHref(context, cr) },
        ...(cr.origin_session_id ? [{ label: 'Session that made it', href: sessionHref(context.env, cr.origin_session_id) }] : []),
      ],
    },
    {
      ...base,
      summary: description.slice(0, 4000),
      files_changed: stats?.files ?? null,
      additions: stats?.additions ?? null,
      deletions: stats?.deletions ?? null,
      can_merge: cr.status === 'open' ? (preview?.can_merge ?? null) : null,
      conflicts: preview?.conflicts ?? [],
    },
  )
}

async function merge(id: string, message: string, context: PlatformToolContext) {
  const read = await show(id, 'merge', context)
  if ('failed' in read) return read.failed
  const { cr } = read
  if (cr.status !== 'open') {
    return fail(TOOL, 'merge', `${label(cr)} is ${cr.status ?? 'not open'}`, { kind: 'invalid', message: `Change request ${label(cr)} is ${cr.status ?? 'not open'}: only an open one merges.` }, context)
  }
  const merged = await cliRun(['cr', 'merge', id, ...(message ? [`--message=${message}`] : [])], context)
  if ('error' in merged) return fail(TOOL, 'merge', `Could not merge ${label(cr)}`, merged.error, context)
  // The merge carried other open requests' commits too: the CLI names them on one line.
  const also = /Also merged ([#\d, ]+)/.exec(merged.text)?.[1]?.match(/#\d+/g) ?? []
  return ok(
    TOOL,
    'merge',
    {
      title: `Merged ${label(cr)} ${cr.title ?? ''}`.trim(),
      subtitle: also.length > 0 ? `${also.join(', ')} merged with it: their changes were part of it.` : 'The change is in the project now.',
      links: [{ label: 'Review', href: reviewHref(context, cr) }],
    },
    { ...summary(cr, new Map()), status: 'merged', also_merged: also },
  )
}

async function close(id: string, context: PlatformToolContext) {
  const read = await show(id, 'close', context)
  if ('failed' in read) return read.failed
  const { cr } = read
  if (cr.status !== 'open') {
    return ok(TOOL, 'close', { title: `${label(cr)} was already ${cr.status ?? 'closed'}`, links: [{ label: 'Review', href: reviewHref(context, cr) }] }, { ...summary(cr, new Map()), closed: false })
  }
  const closed = await cliRun(['cr', 'close', id], context)
  if ('error' in closed) return fail(TOOL, 'close', `Could not close ${label(cr)}`, closed.error, context)
  return ok(
    TOOL,
    'close',
    { title: `Closed ${label(cr)} ${cr.title ?? ''}`.trim(), subtitle: 'Nothing was merged. It can be reopened in Review.', links: [{ label: 'Review', href: reviewHref(context, cr) }] },
    { ...summary(cr, new Map()), status: 'closed', closed: true },
  )
}

export default {
  description:
    "The project's change requests: a proposed change to the project files, waiting for someone to approve it. " +
    'Actions: `list` (status: open (default) | merged | closed | all; each with its number, title, author and status); ' +
    '`get` (id: its summary, how many files it changes, and whether it can merge); `merge` (id, optional message); `close` (id: closes it without merging). ' +
    'id is the number ("3" or "#3") or the cr_id. ' +
    'Merging and closing change the project for everyone: first say what will merge or close, ask once, and merge only after the person agreed in this conversation. ' +
    'To make a change, hand it to an agent that has the project files: it opens the change request.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS], description: 'What to do.' },
      id: { type: 'string', description: 'For get, merge and close: the change request number ("3" or "#3") or its cr_id.' },
      status: { type: 'string', enum: [...STATUSES], description: 'For list: which ones. Default open.' },
      message: { type: 'string', description: 'For merge: the merge message. Optional.' },
    },
    required: ['action'],
  },
  async execute(args: Record<string, any>, context: PlatformToolContext) {
    const action = String(args.action ?? '')
    if (action === 'list') {
      const status = (STATUSES as readonly string[]).includes(args.status) ? String(args.status) : 'open'
      return list(status, context)
    }
    if (!(ACTIONS as readonly string[]).includes(action)) return fail(TOOL, action, 'Unknown action', { kind: 'invalid', message: `Use one of: ${ACTIONS.join(', ')}.` }, context)
    const id = typeof args.id === 'string' ? args.id.trim().replace(/^#/, '') : typeof args.id === 'number' ? String(args.id) : ''
    if (!id) return fail(TOOL, action, 'Which change request?', { kind: 'invalid', message: 'Pass id: its number or cr_id, as list shows it.' }, context)
    const badId = cliArgProblem('id', id)
    if (badId) return fail(TOOL, action, 'Which change request?', { kind: 'invalid', message: badId }, context)
    if (action === 'get') return get(id, context)
    if (action === 'close') return close(id, context)
    const message = typeof args.message === 'string' ? args.message.trim() : ''
    return merge(id, message, context)
  },
}
