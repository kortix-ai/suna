import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

/** Read at most this many bytes from the end of a file for one tail. */
const TAIL_READ_CAP = 4 * 1024 * 1024

/** The last `lines` lines of a file, reading only its tail. Null when absent. */
export function tailFile(path: string, lines: number): string | null {
  // Open first, then fstat the descriptor: no exists/stat-then-open window
  // (the file can rotate underneath a reader at any time).
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  try {
    const size = fstatSync(fd).size
    const span = Math.min(size, TAIL_READ_CAP)
    if (span === 0) return ''
    const buf = Buffer.alloc(span)
    readSync(fd, buf, 0, span, size - span)
    let text = buf.toString('utf8')
    if (span < size) {
      // Started mid-line: drop the partial first line.
      const nl = text.indexOf('\n')
      text = nl >= 0 ? text.slice(nl + 1) : ''
    }
    const parts = text.split('\n')
    if (parts[parts.length - 1] === '') parts.pop()
    return parts.slice(-lines).join('\n') + (parts.length ? '\n' : '')
  } finally {
    closeSync(fd)
  }
}

