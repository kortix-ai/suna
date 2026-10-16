/**
 * A real OpenCode (the pinned version, `packages/shared/src/runtime-versions.json`)
 * in an isolated home for harness tests: its own HOME/XDG dirs, a git workspace
 * (OpenCode keys a project by it), a config whose one provider is a fake model
 * on 127.0.0.1 with a dummy key, and a dead loopback proxy for anything else.
 *
 * The binary is the Kortix CLI's managed copy (`~/.kortix/opencode/<version>/opencode`);
 * a machine without it downloads the npm platform package once, as the CLI does.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as tar from 'tar'
import versions from '../../../../../packages/shared/src/runtime-versions.json'

export const OPENCODE_VERSION = versions.opencode
export const PROVIDER = 'mock'

export async function openCodeBin(): Promise<string> {
  const bin = join(homedir(), '.kortix', 'opencode', OPENCODE_VERSION, 'opencode')
  if (existsSync(bin)) return bin
  const pkg = `opencode-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}`
  const response = await fetch(`https://registry.npmjs.org/${pkg}/-/${pkg}-${OPENCODE_VERSION}.tgz`)
  if (!response.ok) throw new Error(`${pkg}@${OPENCODE_VERSION}: HTTP ${response.status}`)
  const scratch = mkdtempSync(join(tmpdir(), 'opencode-bin-'))
  try {
    await Bun.write(join(scratch, 'pkg.tgz'), await response.arrayBuffer())
    await tar.x({ file: join(scratch, 'pkg.tgz'), cwd: scratch })
    mkdirSync(dirname(bin), { recursive: true })
    copyFileSync(join(scratch, 'package/bin/opencode'), `${bin}.${process.pid}`)
    chmodSync(`${bin}.${process.pid}`, 0o755)
    renameSync(`${bin}.${process.pid}`, bin)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  return bin
}

export type OpenCodeServer = { url: string; proc: ChildProcess; stop: () => Promise<void> }

/** A fresh home + workspace; `serve` starts OpenCode on it. `root` holds both, for the caller to remove. */
export function openCodeBox(bin: string, model: { origin: string; id: string }) {
  const root = mkdtempSync(join(tmpdir(), 'oc-box-'))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  const xdg = { XDG_DATA_HOME: join(home, '.local/share'), XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'), XDG_CACHE_HOME: join(home, '.cache') }
  for (const d of [...Object.values(xdg), join(home, 'tmp'), workspace]) mkdirSync(d, { recursive: true })
  const config = join(xdg.XDG_CONFIG_HOME, 'opencode', 'opencode.json')
  mkdirSync(dirname(config), { recursive: true })
  writeFileSync(config, JSON.stringify({
    $schema: 'https://opencode.ai/config.json', autoupdate: false, share: 'disabled', lsp: false, formatter: false, snapshot: false,
    model: `${PROVIDER}/${model.id}`, small_model: `${PROVIDER}/${model.id}`, enabled_providers: [PROVIDER],
    provider: { [PROVIDER]: { npm: '@ai-sdk/openai-compatible', name: 'Fake', options: { baseURL: `${model.origin}/v1`, apiKey: 'dummy-not-a-real-key' }, models: { [model.id]: { name: model.id, tool_call: true, attachment: true, reasoning: false, limit: { context: 200_000, output: 8_000 }, modalities: { input: ['text', 'image', 'pdf'], output: ['text'] } } } } },
    permission: { '*': 'allow', external_directory: 'allow' },
    compaction: { auto: false, prune: false },
  }))
  const dead = 'http://127.0.0.1:9'
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: join(home, 'tmp'), TERM: 'dumb', ...xdg,
    OPENCODE_CONFIG: config, OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_MODELS_URL: `${dead}/models`,
    OPENCODE_DISABLE_PRUNE: '1', OPENCODE_DISABLE_AUTOCOMPACT: '1', OPENCODE_DISABLE_TERMINAL_TITLE: '1',
    HTTP_PROXY: dead, HTTPS_PROXY: dead, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
  }
  for (const args of [['init', '-q', '-b', 'main'], ['commit', '-q', '--allow-empty', '-m', 'init']]) spawnSync('git', args, { cwd: workspace, env })

  async function serve(): Promise<OpenCodeServer> {
    const proc = spawn(bin, ['--pure', 'serve', '--port', '0', '--hostname', '127.0.0.1'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`opencode serve did not start in 30 s:\n${log}`)), 30_000)
      const read = (b: Buffer) => {
        log += b.toString()
        const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(log)
        if (m) clearTimeout(timer), resolve(m[1]!)
      }
      proc.stdout!.on('data', read)
      proc.stderr!.on('data', read)
      proc.once('exit', (code) => (clearTimeout(timer), reject(new Error(`opencode serve exited ${code}:\n${log}`))))
    })
    // A process a signal ended has exitCode null: without the signalCode check a second stop() waits 3 s for an exit that already happened.
    const gone = () => proc.exitCode !== null || proc.signalCode !== null
    const stop = async () => {
      if (gone()) return
      const exited = new Promise((r) => proc.once('exit', r))
      proc.kill('SIGTERM')
      await Promise.race([exited, Bun.sleep(3_000)])
      if (!gone()) proc.kill('SIGKILL')
    }
    return { url, proc, stop }
  }

  return { root, home, workspace, env, dbPath: join(xdg.XDG_DATA_HOME, 'opencode', 'opencode.db'), serve }
}
