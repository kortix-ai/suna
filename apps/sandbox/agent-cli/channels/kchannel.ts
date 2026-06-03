#!/usr/bin/env bun
import { parseArgs, out, CliError, handleError, getEnv } from '../lib';

interface ChannelSummary {
  platform: string;
  connected: boolean;
  workspace_id: string | null;
  workspace_name: string | null;
  bot_user_id: string | null;
}

function describeSlack(): ChannelSummary {
  return {
    platform: 'slack',
    connected: Boolean(getEnv('SLACK_BOT_TOKEN')),
    workspace_id: getEnv('SLACK_TEAM_ID') ?? null,
    workspace_name: getEnv('SLACK_TEAM_NAME') ?? null,
    bot_user_id: getEnv('SLACK_BOT_USER_ID') ?? null,
  };
}

const PLATFORMS: Record<string, () => ChannelSummary> = {
  slack: describeSlack,
};

async function main(): Promise<void> {
  const { command, args, flags } = parseArgs(process.argv);
  switch (command) {
    case 'list':
    case 'ls': {
      const platformFilter = flags.platform;
      const channels = Object.entries(PLATFORMS)
        .filter(([name]) => !platformFilter || name === platformFilter)
        .map(([, fn]) => fn());
      const connected = channels.filter((c) => c.connected);
      out(
        connected.length === 0
          ? { ok: true, channels: [], message: 'No channels connected for this project.' }
          : { ok: true, channels: connected },
      );
      return;
    }

    case 'info':
    case 'get': {
      const platform = args[0];
      if (!platform) throw new CliError('Platform required. Try: kchannel info slack', 'MISSING_ARGS');
      const fn = PLATFORMS[platform];
      if (!fn) throw new CliError(`Unknown platform "${platform}". Known: ${Object.keys(PLATFORMS).join(', ')}`);
      const summary = fn();
      out(
        summary.connected
          ? { ok: true, channel: summary }
          : { ok: true, channel: summary, message: `${platform} is not connected for this project.` },
      );
      return;
    }

    case 'help':
    default:
      console.log(`
kchannel — channel discovery

Tells the agent which communication platforms are connected for this project.
Connections live in project_secrets and are injected as env vars at sandbox
spawn.

Commands:
  list [--platform slack]            List connected platforms.
  info <platform>                    Workspace/team/bot details for one.
  help                               Show this help.

Once connected, post messages via:
  slack send --channel C0... --text "hi"

Management (connect/disconnect/set defaults) is host-side — use the
Kortix dashboard or \`kortix channels\` on your machine.
`);
      return;
  }
}

if (import.meta.main) {
  main().catch(handleError);
}
