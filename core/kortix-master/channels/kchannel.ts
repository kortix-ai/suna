#!/usr/bin/env bun
/**
 * kchannel — Channel management CLI.
 *
 * Usage:
 *   kchannel list [--platform telegram|slack]
 *   kchannel info <id>
 *   kchannel enable <id>
 *   kchannel disable <id>
 *   kchannel remove <id>
 *   kchannel set <id> --agent <name> --model <provider/model> --instructions "..."
 *
 * Output: JSON always.
 */

import {
  listChannels, getChannel, enableChannel, disableChannel,
  deleteChannel, updateChannel, type ChannelConfig,
} from "./channel-db"

function out(data: unknown): void {
  console.log(JSON.stringify(data, null, 2))
}

function formatChannel(c: ChannelConfig): any {
  return {
    id: c.id,
    platform: c.platform,
    name: c.name,
    enabled: c.enabled,
    bot: c.bot_username ? `@${c.bot_username}` : "?",
    agent: c.default_agent,
    model: c.default_model,
    webhook: c.webhook_path,
    created: c.created_at.slice(0, 10),
    created_by: c.created_by,
  }
}

function parseArgs(argv: string[]): { command: string; args: string[]; flags: Record<string, string> } {
  const all = argv.slice(2)
  const command = all[0] ?? "help"
  const args: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 1; i < all.length; i++) {
    const a = all[i]!
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const val = all[i + 1] && !all[i + 1]!.startsWith("--") ? all[++i]! : "true"
      flags[key] = val
    } else {
      args.push(a)
    }
  }
  return { command, args, flags }
}

async function main(): Promise<void> {
  const { command, args, flags } = parseArgs(process.argv)

  switch (command) {
    case "list": case "ls": {
      const channels = listChannels(flags.platform ? { platform: flags.platform } : undefined)
      if (!channels.length) { out({ ok: true, channels: [], message: "No channels configured" }); break }
      out({ ok: true, channels: channels.map(formatChannel) })
      break
    }

    case "info": case "get": {
      const id = args[0]
      if (!id) { out({ ok: false, error: "Channel ID required" }); process.exit(1) }
      const ch = getChannel(id)
      if (!ch) { out({ ok: false, error: `Channel ${id} not found` }); process.exit(1) }
      out({ ok: true, channel: { ...formatChannel(ch), instructions: ch.instructions, webhook_secret: ch.webhook_secret } })
      break
    }

    case "enable": {
      const id = args[0]
      if (!id) { out({ ok: false, error: "Channel ID required" }); process.exit(1) }
      const ch = enableChannel(id)
      if (!ch) { out({ ok: false, error: `Channel ${id} not found` }); process.exit(1) }
      out({ ok: true, channel: formatChannel(ch), message: `${ch.name} enabled` })
      break
    }

    case "disable": {
      const id = args[0]
      if (!id) { out({ ok: false, error: "Channel ID required" }); process.exit(1) }
      const ch = disableChannel(id)
      if (!ch) { out({ ok: false, error: `Channel ${id} not found` }); process.exit(1) }
      out({ ok: true, channel: formatChannel(ch), message: `${ch.name} disabled` })
      break
    }

    case "remove": case "rm": case "delete": {
      const id = args[0]
      if (!id) { out({ ok: false, error: "Channel ID required" }); process.exit(1) }
      const ch = getChannel(id)
      if (!ch) { out({ ok: false, error: `Channel ${id} not found` }); process.exit(1) }
      deleteChannel(id)
      out({ ok: true, message: `${ch.name} removed` })
      break
    }

    case "set": case "update": {
      const id = args[0]
      if (!id) { out({ ok: false, error: "Channel ID required" }); process.exit(1) }
      const updates: Record<string, any> = {}
      if (flags.agent) updates.default_agent = flags.agent
      if (flags.model) updates.default_model = flags.model
      if (flags.instructions) updates.instructions = flags.instructions
      if (flags.name) updates.name = flags.name
      if (!Object.keys(updates).length) { out({ ok: false, error: "Nothing to update. Use --agent, --model, --instructions, --name" }); process.exit(1) }
      const ch = updateChannel(id, updates)
      if (!ch) { out({ ok: false, error: `Channel ${id} not found` }); process.exit(1) }
      out({ ok: true, channel: formatChannel(ch), message: `${ch.name} updated` })
      break
    }

    case "help":
    default:
      console.log(`
kchannel — Channel Management

Commands:
  list [--platform telegram|slack]    List channels
  info <id>                           Channel details
  enable <id>                         Enable channel
  disable <id>                        Disable channel
  remove <id>                         Delete channel
  set <id> [--agent X] [--model X] [--instructions X] [--name X]  Update settings
`)
      break
  }
}

main().catch((err) => {
  out({ ok: false, error: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
