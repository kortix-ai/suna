import { help } from '../style.ts';
import { runSessionsChat } from './sessions-chat.ts';

const CONNECT_HELP = help`Usage: kortix sessions connect [<session-id>] [options]

Open an interactive terminal chat with the ACP agent bound to a Kortix session.
This command is harness-neutral: Claude, Codex, OpenCode, and Pi all use the
same project-session ACP endpoint and persisted transcript.

  --project <id>   Pin this project id (skips the cross-host scan).
  --host <name>    Pin this Kortix host (skips the cross-host scan).
  -h, --help       Show this help.

Alias of [36mkortix sessions chat[0m for users who think in terms of
connecting to a running session.`;

export async function runSessionsConnect(argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(`${CONNECT_HELP}\n`);
    return 0;
  }
  return runSessionsChat(argv);
}
