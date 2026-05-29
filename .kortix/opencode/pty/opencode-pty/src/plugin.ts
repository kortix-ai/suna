import type { PluginContext, PluginResult } from './plugin/types.ts'
import { initManager, isBunPtyAvailable, bunPtyLoadError, manager } from './plugin/pty/manager.ts'
import { initPermissions } from './plugin/pty/permissions.ts'
import { ptySpawn } from './plugin/pty/tools/spawn.ts'
import { ptyWrite } from './plugin/pty/tools/write.ts'
import { ptyRead } from './plugin/pty/tools/read.ts'
import { ptyList } from './plugin/pty/tools/list.ts'
import { ptyKill } from './plugin/pty/tools/kill.ts'

export const PTYPlugin = async ({ client, directory, serverUrl }: PluginContext): Promise<PluginResult> => {
  // ── Load-time diagnostics ───────────────────────────────────────────────
  const available = isBunPtyAvailable()
  if (!available) {
    const loadErr = bunPtyLoadError()
    console.error(
      `[opencode-pty] ⚠ Plugin loaded but the PTY backend is NOT available.\n` +
        `  PTY tools (pty_spawn, pty_read, pty_write, pty_list, pty_kill) will return errors.\n` +
        `  Load error: ${loadErr}\n` +
        `  Platform: ${process.platform}/${process.arch}\n` +
        `  Runtime: ${typeof Bun !== 'undefined' ? `Bun ${(Bun as any).version}` : 'NOT Bun'}\n` +
        `  cwd: ${process.cwd()}\n` +
        `  directory: ${directory}\n` +
        `  Troubleshooting:\n` +
        `    1. Is the OpenCode /pty backend responding?\n` +
        `    2. Is OpenCode serving on ${serverUrl.origin}?\n` +
        `    3. Are PTY websocket connections allowed in this runtime?\n`
    )
  } else {
    console.log(
      `[opencode-pty] ✓ Plugin loaded. PTY backend available. Platform: ${process.platform}/${process.arch}`
    )
  }

  initPermissions(client, directory)
  initManager(client, serverUrl, directory)

  return {
    tool: {
      pty_spawn: ptySpawn,
      pty_write: ptyWrite,
      pty_read: ptyRead,
      pty_list: ptyList,
      pty_kill: ptyKill,
    },
    event: async ({ event }) => {
      if (event.type === 'session.deleted') {
        manager.cleanupBySession(event.properties.info.id)
      }
    },
  }
}

export default PTYPlugin
