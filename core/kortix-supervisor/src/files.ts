import { existsSync, mkdirSync, statSync } from 'fs'
import { execFileSync } from 'child_process'
import type { FileInstallResponse, FileInstallSpec } from './schema'

const ALLOWED_DEST_PREFIXES = [
  process.env.KORTIX_MEMBER_HOME_ROOT || '/srv/kortix/home',
  process.env.KORTIX_PROJECT_ROOT || '/srv/kortix/projects',
]

export function installUpload(spec: FileInstallSpec): FileInstallResponse {
  if (!existsSync(spec.src) || !statSync(spec.src).isFile()) {
    throw new Error(`src not found: ${spec.src}`)
  }
  const destDir = normalizeDest(spec.dest_dir)
  if (!destDir) throw new Error(`invalid dest: ${spec.dest_dir}`)

  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })

  const safeName = spec.filename.replace(/[^a-zA-Z0-9._-]/g, '_') || 'upload'
  const finalPath = pickFreePath(destDir, safeName)

  try {
    execFileSync('mv', [spec.src, finalPath], { stdio: 'ignore' })
    execFileSync('chown', [`${spec.owner_uid}:${spec.group ?? spec.owner_uid}`, finalPath], {
      stdio: 'ignore',
    })
    execFileSync('chmod', ['0640', finalPath], { stdio: 'ignore' })
  } catch (err) {
    throw new Error(
      `install failed ${spec.src} -> ${finalPath}: ${err instanceof Error ? err.message : err}`,
    )
  }

  return { path: finalPath }
}

function normalizeDest(dest: string): string | null {
  if (typeof dest !== 'string' || !dest.startsWith('/')) return null
  const normalized = dest.replace(/\/+$/, '')
  if (!ALLOWED_DEST_PREFIXES.some((p) => normalized === p || normalized.startsWith(`${p}/`))) {
    return null
  }
  return normalized
}

function pickFreePath(dir: string, filename: string): string {
  const dot = filename.lastIndexOf('.')
  const base = dot > 0 ? filename.slice(0, dot) : filename
  const ext = dot > 0 ? filename.slice(dot) : ''
  let attempt = `${dir}/${filename}`
  let n = 1
  while (existsSync(attempt)) {
    attempt = `${dir}/${base}-${Date.now().toString(36)}-${n}${ext}`
    n += 1
    if (n > 50) break
  }
  return attempt
}
