/**
 * The chat commands Kortix answers itself, for every platform: names, aliases,
 * the help and menu lines, and the parser for a platform whose commands arrive
 * as text. No imports: a platform's menu registrar reads this at load
 * (channels/telegram/menu.ts). The runners are channels/core/commands.ts.
 */

export interface ChannelCommandSpec {
  /** `[a-z0-9_]{1,32}`: valid on Telegram and Discord. */
  name: string;
  /** Parsed, never in a menu or /help. */
  aliases: readonly string[];
  /** The /help line's left side: '/model [id]'. */
  usage: string;
  /** 3–100 characters: the menu line and the /help line. */
  description: string;
}

/** In menu order. A verb listed here never reaches the agent. */
export const CHANNEL_COMMANDS = [
  { name: 'new', aliases: ['reset'], usage: '/new', description: "Start a new conversation and stop this chat's run" },
  { name: 'stop', aliases: ['cancel'], usage: '/stop', description: "Stop the agent's current run in this chat" },
  { name: 'status', aliases: [], usage: '/status', description: "Show this chat's project, agent, model and session" },
  { name: 'model', aliases: ['models'], usage: '/model [id]', description: 'List the models, or switch this chat to one' },
  { name: 'agent', aliases: ['agents'], usage: '/agent [name]', description: 'List the agents, or switch this chat to one' },
  { name: 'help', aliases: ['start'], usage: '/help', description: 'List the commands' },
] as const satisfies readonly ChannelCommandSpec[];

export type ChannelCommandName = (typeof CHANNEL_COMMANDS)[number]['name'];

export interface ParsedCommand {
  name: ChannelCommandName;
  /** The text after the verb, trimmed; its line breaks stay. */
  arg: string;
}

/** `/verb`, `/verb@bot`, then whitespace and the argument. A verb that runs into other text (`/new-york`) is no command. */
const COMMAND = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{1,64}))?(?:\s+([\s\S]*))?$/;

/**
 * Text platforms only (Telegram, Viber). Null: not a command; the text goes to the agent. A verb is
 * matched in any case. A `@suffix` must name this bot; a null `botUsername` accepts any.
 */
export function parseChannelCommand(text: string, botUsername: string | null): ParsedCommand | null {
  const match = COMMAND.exec(text);
  if (!match) return null;
  const [, verb, bot, arg] = match;
  if (bot && botUsername && bot.toLowerCase() !== botUsername.toLowerCase()) return null;
  const lower = verb!.toLowerCase();
  const spec = CHANNEL_COMMANDS.find((c) => c.name === lower || (c.aliases as readonly string[]).includes(lower));
  return spec ? { name: spec.name, arg: (arg ?? '').trim() } : null;
}

/** The entries a platform registers in its menu: names only, in this order. */
export function commandMenu(): Array<{ command: string; description: string }> {
  return CHANNEL_COMMANDS.map((c) => ({ command: c.name, description: c.description }));
}
