/**
 * Build the Kortix Agent harness into `dist/opencode/`: the exact folder the
 * meta sandbox image copies into its OpenCode config dir.
 *
 * Plugins are bundled into one self-contained `.js` each (their dependencies
 * inlined), so the sandbox needs no node_modules, no lockfile and no network
 * at boot. Everything else (commands, agents) is copied as is. `lib/` is only
 * reachable through the bundles, and `package.json` is a dev-only manifest.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const src = join(root, 'opencode')
const out = join(root, 'dist', 'opencode')
const SKIP = new Set(['lib', 'plugin', 'node_modules', 'package.json', 'bun.lock'])

rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'plugin'), { recursive: true })

for (const entry of readdirSync(src)) {
  if (SKIP.has(entry)) continue
  cpSync(join(src, entry), join(out, entry), { recursive: true })
}

const plugins = readdirSync(join(src, 'plugin')).filter((file) => file.endsWith('.ts'))
const result = await Bun.build({
  entrypoints: plugins.map((file) => join(src, 'plugin', file)),
  outdir: join(out, 'plugin'),
  target: 'bun',
  format: 'esm',
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
for (const file of plugins) {
  const bundled = join(out, 'plugin', file.replace(/\.ts$/, '.js'))
  if (!existsSync(bundled)) {
    console.error(`missing bundle ${bundled}`)
    process.exit(1)
  }
}
console.log(`meta-harness: built ${plugins.length} plugin(s) into ${out}`)
