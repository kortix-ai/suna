export function stripTeamsMentions(text: string): string {
  return text
    .replace(/<at[^>]*>.*?<\/at>/gi, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface TeamsCommand {
  verb: string;
  arg: string;
}

const COMMAND_VERBS = new Set([
  'login',
  'connect',
  'logout',
  'disconnect',
  'whoami',
  'who',
  'help',
  'status',
  'config',
  'settings',
  'models',
  'model',
  'agents',
  'agent',
  'projects',
  'use',
  'switch',
]);

export function parseTeamsCommand(text: string | undefined): TeamsCommand | null {
  const stripped = stripTeamsMentions(text ?? '').trim();
  if (!stripped.startsWith('/')) return null;
  const body = stripped.slice(1).trim();
  if (!body) return null;
  const [first, ...rest] = body.split(/\s+/);
  const verb = first.toLowerCase();
  if (!COMMAND_VERBS.has(verb)) return null;
  return { verb, arg: rest.join(' ').trim() };
}
