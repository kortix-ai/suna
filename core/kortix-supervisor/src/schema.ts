export interface DaemonSpec {
  supabase_user_id: string
  username: string
  linux_uid: number
  storage_base: string
  migrate_from?: string
  role?: 'owner' | 'admin' | 'member' | 'platform_admin'
  project_ids?: string[]
}

export interface DaemonInfo {
  supabase_user_id: string
  username: string
  linux_uid: number
  port: number
  pid: number
  started_at: number
  last_used: number
}

export interface EnsureResponse {
  port: number
}

export interface ProjectEnsureSpec {
  project_id: string
  kind?: 'scoped' | 'workspace'
  members: Array<{ username: string; linux_uid: number }>
  migrate_from?: string
}

export interface ProjectGrantSpec {
  project_id: string
  username: string
  linux_uid: number
}

export interface ProjectRevokeSpec {
  project_id: string
  username: string
  supabase_user_id?: string
}

export interface ProjectDeleteSpec {
  project_id: string
  archive_to?: string
}

export interface ProjectOpResponse {
  path: string
  group: string
}

export interface FileInstallSpec {
  src: string
  dest_dir: string
  filename: string
  owner_uid: number
  group?: string
}

export interface FileInstallResponse {
  path: string
}


