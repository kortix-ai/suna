const SOCKET_PATH =
  process.env.KORTIX_SUPERVISOR_SOCKET || '/run/kortix/supervisor.sock'
const TIMEOUT_MS = 30_000

export interface ProjectMember {
  username: string
  linux_uid: number
}

export interface ProjectOpResult {
  path: string
  group: string
}

export async function ensureProjectWorkspace(input: {
  projectId: string
  kind?: 'scoped' | 'workspace'
  members: ProjectMember[]
  migrateFrom?: string
}): Promise<ProjectOpResult> {
  return callSupervisor('/project/ensure', {
    project_id: input.projectId,
    kind: input.kind ?? 'scoped',
    members: input.members,
    migrate_from: input.migrateFrom,
  })
}

export async function grantProjectAccess(input: {
  projectId: string
  username: string
  linuxUid: number
}): Promise<ProjectOpResult> {
  return callSupervisor('/project/grant', {
    project_id: input.projectId,
    username: input.username,
    linux_uid: input.linuxUid,
  })
}

export async function revokeProjectAccess(input: {
  projectId: string
  username: string
  supabaseUserId?: string
}): Promise<ProjectOpResult> {
  return callSupervisor('/project/revoke', {
    project_id: input.projectId,
    username: input.username,
    supabase_user_id: input.supabaseUserId,
  })
}

export async function deleteProjectWorkspace(input: {
  projectId: string
}): Promise<ProjectOpResult> {
  return callSupervisor('/project/delete', { project_id: input.projectId })
}

export async function installUploadedFile(input: {
  src: string
  destDir: string
  filename: string
  ownerUid: number
  group?: string
}): Promise<{ path: string }> {
  const res = await fetch('http://supervisor/file/install', {
    // @ts-ignore
    unix: SOCKET_PATH,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      src: input.src,
      dest_dir: input.destDir,
      filename: input.filename,
      owner_uid: input.ownerUid,
      group: input.group,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`supervisor /file/install failed: ${res.status} ${text}`)
  }
  const payload = (await res.json()) as { path?: string }
  if (!payload.path) throw new Error(`supervisor install returned no path`)
  return { path: payload.path }
}

async function callSupervisor(path: string, body: unknown): Promise<ProjectOpResult> {
  const res = await fetch(`http://supervisor${path}`, {
    // @ts-ignore Bun supports unix option
    unix: SOCKET_PATH,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`supervisor ${path} failed: ${res.status} ${text}`)
  }
  const payload = (await res.json()) as { path?: string; group?: string; message?: string }
  if (!payload.path || !payload.group) {
    throw new Error(`supervisor ${path} returned invalid payload: ${JSON.stringify(payload)}`)
  }
  return { path: payload.path, group: payload.group }
}
