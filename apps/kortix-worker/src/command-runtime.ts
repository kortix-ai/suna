/**
 * The immutable project-command contract baked into a Pi runtime artifact.
 *
 * Discovery happens in apps/api at the session's exact Git SHA. The worker
 * receives only this data. It never reads command files from the environment
 * or from a branch that can move after the session starts.
 */
export interface PiCommand {
  name: string;
  description?: string;
  template: string;
  agent?: string;
  model?: string;
  variant?: string;
  subtask?: boolean;
  source: 'command';
  hints: string[];
}

const POSITIONAL_ARGUMENT = /\$(\d+)/g;
const ARGUMENT_TOKEN = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi;
const TRIM_ARGUMENT_QUOTES = /^["']|["']$/g;
const SHELL_INTERPOLATION = /!`([^`]+)`/;
const FILE_REFERENCE = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/;

export class PiCommandUnsupportedError extends Error {
  readonly code = 'PI_COMMAND_FEATURE_UNSUPPORTED';

  constructor(
    readonly feature: string,
    commandName: string,
  ) {
    super(`Pi command "${commandName}" cannot run because ${feature} is not supported`);
    this.name = 'PiCommandUnsupportedError';
  }
}

/**
 * Expand a command exactly like OpenCode's command prompt path:
 *
 * - quoted arguments remain one positional argument and lose outer quotes;
 * - the highest numbered placeholder consumes every remaining argument;
 * - `$ARGUMENTS` receives the unmodified argument string;
 * - arguments append after a blank line when no placeholder exists.
 */
export function expandCommandTemplate(template: string, argumentsText: string): string {
  const raw = argumentsText.match(ARGUMENT_TOKEN) ?? [];
  const args = raw.map((argument) => argument.replace(TRIM_ARGUMENT_QUOTES, ''));
  const placeholders = template.match(POSITIONAL_ARGUMENT) ?? [];
  let last = 0;
  for (const placeholder of placeholders) {
    const position = Number(placeholder.slice(1));
    if (position > last) last = position;
  }

  const withPositionals = template.replaceAll(POSITIONAL_ARGUMENT, (_placeholder, index) => {
    const position = Number(index);
    const argumentIndex = position - 1;
    if (argumentIndex >= args.length) return '';
    if (position === last) return args.slice(argumentIndex).join(' ');
    return args[argumentIndex] ?? '';
  });
  const usesArgumentsPlaceholder = template.includes('$ARGUMENTS');
  let expanded = withPositionals.replaceAll('$ARGUMENTS', argumentsText);
  if (placeholders.length === 0 && !usesArgumentsPlaceholder && argumentsText.trim()) {
    expanded = `${expanded}\n\n${argumentsText}`;
  }
  return expanded.trim();
}

/**
 * Produce the single text prompt Pi admits for this command.
 *
 * Pi sessions are compiled for one agent and one model. Agent/model overrides
 * and child-session commands therefore fail instead of silently running with
 * different semantics. Shell interpolation and file-reference expansion also
 * fail until they can use the environment and the same permission boundary as
 * normal tools.
 */
export function preparePiCommand(command: PiCommand, argumentsText: string): string {
  if (command.agent !== undefined) {
    throw new PiCommandUnsupportedError('agent overrides', command.name);
  }
  if (command.model !== undefined) {
    throw new PiCommandUnsupportedError('model overrides', command.name);
  }
  if (command.variant !== undefined) {
    throw new PiCommandUnsupportedError('variant overrides', command.name);
  }
  if (command.subtask) throw new PiCommandUnsupportedError('subtask execution', command.name);

  const prompt = expandCommandTemplate(command.template, argumentsText);
  if (SHELL_INTERPOLATION.test(prompt)) {
    throw new PiCommandUnsupportedError('shell interpolation', command.name);
  }
  if (FILE_REFERENCE.test(prompt)) {
    throw new PiCommandUnsupportedError('file references', command.name);
  }
  return prompt;
}
