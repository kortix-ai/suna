import { spawn } from 'child_process'

export interface FsEntry {
  name: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  mtime: number
}

export interface FsStat {
  exists: boolean
  type?: 'file' | 'directory' | 'symlink' | 'other'
  size?: number
  mode?: number
  mtime?: number
}

export interface FsContent {
  type: 'text' | 'binary'
  encoding?: 'utf-8' | 'base64'
  content: string
  size: number
  mime?: string
}

interface AsUserResult {
  code: number
  stdout: string
  stderr: string
}

const READ_LIMIT_BYTES = 50 * 1024 * 1024

function runAsUser(uid: number, cmd: string, args: string[]): Promise<AsUserResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      uid,
      gid: uid,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    proc.stdout.on('data', (d: Buffer) => stdoutChunks.push(d))
    proc.stderr.on('data', (d: Buffer) => stderrChunks.push(d))
    proc.on('exit', (code) =>
      resolve({
        code: code ?? 0,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      }),
    )
    proc.on('error', (err) =>
      resolve({ code: 1, stdout: '', stderr: err.message }),
    )
  })
}

function runAsUserBinary(uid: number, cmd: string, args: string[], maxBytes: number): Promise<{ code: number; buffer: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { uid, gid: uid, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let total = 0
    let truncated = false
    const stderrChunks: Buffer[] = []
    proc.stdout.on('data', (d: Buffer) => {
      if (truncated) return
      if (total + d.length > maxBytes) {
        truncated = true
        chunks.push(d.subarray(0, maxBytes - total))
        total = maxBytes
        proc.kill()
      } else {
        chunks.push(d)
        total += d.length
      }
    })
    proc.stderr.on('data', (d: Buffer) => stderrChunks.push(d))
    proc.on('exit', (code) =>
      resolve({
        code: code ?? 0,
        buffer: Buffer.concat(chunks),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      }),
    )
    proc.on('error', (err) => resolve({ code: 1, buffer: Buffer.alloc(0), stderr: err.message }))
  })
}

const BUN_BIN = process.env.KORTIX_FS_HELPER_BUN || '/opt/bun/bin/bun'

export async function readdir(uid: number, path: string): Promise<FsEntry[]> {
  const script = `
    const { readdirSync, statSync, lstatSync } = require('fs');
    const path = require('path');
    const target = process.argv[1];
    try {
      const entries = readdirSync(target, { withFileTypes: true });
      const out = entries.map((e) => {
        let type = 'other';
        let size = 0;
        let mtime = 0;
        try {
          const full = path.join(target, e.name);
          const stat = e.isSymbolicLink()
            ? (() => { try { return statSync(full); } catch { return lstatSync(full); } })()
            : (e.isDirectory() ? { size: 0, mtimeMs: lstatSync(full).mtimeMs, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false } : lstatSync(full));
          type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : e.isSymbolicLink() ? 'symlink' : 'other';
          size = stat.size ?? 0;
          mtime = Math.floor((stat.mtimeMs ?? 0));
        } catch {}
        return { name: e.name, type, size, mtime };
      });
      process.stdout.write(JSON.stringify({ ok: true, entries: out }));
    } catch (err) {
      process.stdout.write(JSON.stringify({ ok: false, code: err.code, message: err.message }));
    }
  `
  const res = await runAsUser(uid, BUN_BIN, ['-e', script, path])
  return parseHelperResult<FsEntry[]>(res, 'entries')
}

export async function stat(uid: number, path: string): Promise<FsStat> {
  const script = `
    const { statSync } = require('fs');
    const target = process.argv[1];
    try {
      const s = statSync(target);
      const type = s.isDirectory() ? 'directory' : s.isFile() ? 'file' : s.isSymbolicLink() ? 'symlink' : 'other';
      process.stdout.write(JSON.stringify({ ok: true, exists: true, type, size: s.size, mode: s.mode, mtime: Math.floor(s.mtimeMs) }));
    } catch (err) {
      if (err.code === 'ENOENT') { process.stdout.write(JSON.stringify({ ok: true, exists: false })); return; }
      process.stdout.write(JSON.stringify({ ok: false, code: err.code, message: err.message }));
    }
  `
  const res = await runAsUser(uid, BUN_BIN, ['-e', script, path])
  const parsed = parseHelperRaw(res)
  if (!parsed.exists) return { exists: false }
  return {
    exists: true,
    type: parsed.type,
    size: parsed.size,
    mode: parsed.mode,
    mtime: parsed.mtime,
  }
}

export async function readFile(uid: number, path: string): Promise<FsContent> {
  const res = await runAsUserBinary(uid, '/bin/cat', ['--', path], READ_LIMIT_BYTES)
  if (res.code !== 0) {
    throw fsError(res.code, res.stderr || 'read failed')
  }
  const buffer = res.buffer
  const text = tryAsText(buffer)
  if (text !== null) {
    return { type: 'text', encoding: 'utf-8', content: text, size: buffer.length }
  }
  return { type: 'binary', encoding: 'base64', content: buffer.toString('base64'), size: buffer.length }
}

export async function mkdir(uid: number, path: string): Promise<void> {
  const res = await runAsUser(uid, '/bin/mkdir', ['-p', '--', path])
  if (res.code !== 0) throw fsError(res.code, res.stderr || 'mkdir failed')
}

export async function unlink(uid: number, path: string): Promise<void> {
  const res = await runAsUser(uid, '/bin/rm', ['-rf', '--', path])
  if (res.code !== 0) throw fsError(res.code, res.stderr || 'unlink failed')
}

export async function rename(uid: number, from: string, to: string): Promise<void> {
  const res = await runAsUser(uid, '/bin/mv', ['--', from, to])
  if (res.code !== 0) throw fsError(res.code, res.stderr || 'rename failed')
}

function parseHelperRaw(res: AsUserResult): any {
  if (res.code !== 0 && !res.stdout.trim()) {
    throw new Error(res.stderr.trim() || `helper failed with code ${res.code}`)
  }
  let parsed: any
  try {
    parsed = JSON.parse(res.stdout)
  } catch {
    throw new Error(`helper returned non-json: ${res.stdout.slice(0, 200)} / ${res.stderr}`)
  }
  if (parsed.ok === false) {
    throw fsError(parsed.code, parsed.message || 'helper op failed')
  }
  return parsed
}

function parseHelperResult<T>(res: AsUserResult, field: string): T {
  const parsed = parseHelperRaw(res)
  return parsed[field] as T
}

function fsError(code: string | number, message: string): Error {
  const err = new Error(message) as Error & { code?: string | number }
  err.code = code
  return err
}

function tryAsText(buffer: Buffer): string | null {
  if (buffer.length === 0) return ''
  for (let i = 0; i < Math.min(buffer.length, 4096); i++) {
    if (buffer[i] === 0) return null
  }
  try {
    return buffer.toString('utf8')
  } catch {
    return null
  }
}
