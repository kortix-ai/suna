import { accessSync, constants } from 'fs'

const SEARCH_DIRS = [
  '/usr/local/sbin',
  '/usr/local/bin',
  '/usr/sbin',
  '/usr/bin',
  '/sbin',
  '/bin',
]

const resolved = new Map<string, string>()

function findOnDisk(name: string): string | null {
  for (const dir of SEARCH_DIRS) {
    const full = `${dir}/${name}`
    try {
      accessSync(full, constants.X_OK)
      return full
    } catch {}
  }
  return null
}

export function sysbin(name: string): string {
  const cached = resolved.get(name)
  if (cached) return cached
  const found = findOnDisk(name)
  if (!found) {
    throw new Error(
      `required system binary not found: ${name} (searched ${SEARCH_DIRS.join(':')})`,
    )
  }
  resolved.set(name, found)
  return found
}

export function sysbinSafe(name: string): string {
  try {
    return sysbin(name)
  } catch {
    return name
  }
}
