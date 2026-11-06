/**
 * `kortix spaces` — read and change a space (a channel or a private space) of the
 * project: its name, description, tabs, agents and members.
 *
 * Inside a session the space defaults to the one the session is filed in,
 * and the token acts for the session's person: a change goes through only
 * when that person may make it (the channel's creator or a project manager
 * renames, describes and sets agents; a member adds people; the owner of a private space
 * and any agent working in the space set tabs). The API decides; this
 * command never widens it. Making a channel private stays a person's step.
 */
import { splitHelp } from '../command-argv.ts';
import { emitJson, fail, missing, resolveProjectContext, surfaceApiError, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import type { ApiClient } from '../api/client.ts';
import { C, help, status } from '../style.ts';

const HELP = help`Usage: kortix spaces <subcommand> [<space>] [args] [options]

Read and change a space of the workspace: a channel, your personal space or a
private space with an agent. Inside
a session <space> defaults to the space the session is filed in. A change goes
through with the rights of the person the session works for: the channel's
creator or a workspace manager may rename it, describe it and set its agents; a
member may add people; the owner of a private space and an agent working in the space may set
its tabs. Anyone else gets 403. Making a channel private is a person's step
(the web app). Needs Spaces (the \`chat\` feature flag) on the workspace.

<space> is a space id, a channel slug (#launch or launch), or dm:<agent> for
your private space with that agent (dm:mykortix is your personal space).

Subcommands:
  ls                                 The workspace's channels and your private spaces.
  get [<space>]                      Name, description, agents, tabs.
  rename [<space>] <name>            Rename a channel (its slug follows).
  describe [<space>] <text>          Set a channel's description ("" clears it).
  tabs [<space>]                     List the tabs after Chat.
  tabs [<space>] add <kind> <title> <ref>
                                     Add a tab. kind: file | folder | artifact | app | link.
                                     ref: a Drive file or folder path, an artifact id,
                                     an App slug, or an https URL.
  tabs [<space>] rm <id|title>       Remove a tab.
  tabs [<space>] move <id|title> <position>
                                     Move a tab (1 = first after Chat).
  tabs [<space>] set <json>          Replace every tab: a JSON array of {id,title,kind,ref}.
  agents [<space>] set <name>...     Set a channel's agents (the first is its default).
  post [<space>] "<text>" [--thread <thread id>] [--ask]
                                     Post into the space's main chat as this agent (a new
                                     top-level message), or into one of its threads with
                                     --thread. --ask makes that thread's agent answer;
                                     without it the agent only reads the post. @name or
                                     @email mentions a person (they get a notification
                                     when they may see the space); @agent mentions an agent.
  members [<space>]                  List the people in a channel.
  members [<space>] add <email|user id>...
  members [<space>] rm <email|user id>

Options:
  --space <space>   The space (instead of the positional one).
  --thread <id>     post: the thread to post into.
  --ask             post: the thread's agent answers the post.
  --workspace <id>  Workspace id (default: the linked or session workspace).
  --host <name>     Operate against a non-default Kortix host.
  --json            Machine-readable output.
  -h, --help        Show this help.

Examples:
  kortix spaces rename Launch
  kortix spaces describe "Everything for the November launch"
  kortix spaces tabs add file "About" /Company/Channels/launch/about.md
  kortix spaces agents '#launch' set researcher writer
  kortix spaces members add ana@example.com
  kortix spaces post '#launch' "The weather check is done. @ana, the report is in Files."
  kortix spaces post "Can you approve the draft? @ana" --thread 3f2a1b9c-… --ask
`;

interface SpaceTab {
  id: string;
  title: string;
  kind: string;
  ref: string;
  embeddable?: boolean;
}

interface Space {
  space_id: string;
  kind: 'channel' | 'dm';
  slug: string | null;
  name: string;
  description: string | null;
  is_default: boolean;
  dm_agent_name: string | null;
  can_edit: boolean;
  agents: string[];
  visibility?: string;
  tabs: SpaceTab[];
}

const TAB_KINDS = ['file', 'folder', 'artifact', 'app', 'link'] as const;
const SUBCOMMANDS = ['ls', 'list', 'get', 'rename', 'describe', 'tabs', 'agents', 'members', 'post'] as const;
const TAB_VERBS = new Set(['add', 'rm', 'remove', 'move', 'set']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Which positional args name the space: the first, when more are given than the subcommand needs (pure). */
export function splitSpaceArg(sub: string, args: readonly string[]): { space: string | undefined; rest: string[] } {
  const all = [...args];
  const takeFirst = () => ({ space: all[0], rest: all.slice(1) });
  switch (sub) {
    case 'get':
      return all.length >= 1 ? takeFirst() : { space: undefined, rest: all };
    case 'rename':
    case 'describe':
    case 'post':
      return all.length >= 2 ? takeFirst() : { space: undefined, rest: all };
    case 'tabs':
    case 'members':
      return all.length >= 1 && !TAB_VERBS.has(all[0]!) ? takeFirst() : { space: undefined, rest: all };
    case 'agents':
      return all.length >= 1 && all[0] !== 'set' ? takeFirst() : { space: undefined, rest: all };
    default:
      return { space: undefined, rest: all };
  }
}

/** A space in a listing by id, `#slug`/slug or `dm:<agent>` (pure). */
export function findSpace(spaces: readonly Space[], ref: string): Space | null {
  const clean = ref.trim();
  if (UUID.test(clean)) return spaces.find((s) => s.space_id === clean) ?? null;
  if (clean.toLowerCase().startsWith('dm:')) {
    const agent = clean.slice(3).toLowerCase();
    return spaces.find((s) => s.kind === 'dm' && s.dm_agent_name?.toLowerCase() === agent) ?? null;
  }
  const slug = clean.replace(/^#/, '').toLowerCase();
  return spaces.find((s) => s.kind === 'channel' && s.slug === slug) ?? null;
}

/** A new tab id from its title, unique in `taken` (pure). */
export function tabIdFor(title: string, taken: ReadonlySet<string>): string {
  const base =
    title
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'tab';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** The tabs after one `tabs` verb (pure); a string is the refusal. */
export function editTabs(tabs: readonly SpaceTab[], verb: string, args: readonly string[]): SpaceTab[] | string {
  const strip = (t: SpaceTab): SpaceTab => ({ id: t.id, title: t.title, kind: t.kind, ref: t.ref });
  const list = tabs.map(strip);
  const find = (key: string) => list.findIndex((t) => t.id === key || t.title.toLowerCase() === key.toLowerCase());
  if (verb === 'add') {
    const [kind, title, ref] = args;
    if (!kind || !title || !ref) return 'tabs add needs <kind> <title> <ref>';
    if (!(TAB_KINDS as readonly string[]).includes(kind)) return `kind must be one of: ${TAB_KINDS.join(', ')}`;
    return [...list, { id: tabIdFor(title, new Set(list.map((t) => t.id))), title, kind, ref }];
  }
  if (verb === 'rm' || verb === 'remove') {
    const at = args[0] ? find(args[0]) : -1;
    if (at < 0) return `No tab "${args[0] ?? ''}" in this space.`;
    return list.filter((_, i) => i !== at);
  }
  if (verb === 'move') {
    const at = args[0] ? find(args[0]) : -1;
    const position = Number(args[1]);
    if (at < 0) return `No tab "${args[0] ?? ''}" in this space.`;
    if (!Number.isInteger(position) || position < 1 || position > list.length) return `position must be 1 to ${list.length}`;
    const next = list.filter((_, i) => i !== at);
    next.splice(position - 1, 0, list[at]!);
    return next;
  }
  if (verb === 'set') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args.join(' '));
    } catch {
      return 'tabs set needs a JSON array of {id,title,kind,ref}';
    }
    if (!Array.isArray(parsed)) return 'tabs set needs a JSON array of {id,title,kind,ref}';
    const taken = new Set<string>();
    const out: SpaceTab[] = [];
    for (const raw of parsed as Array<Record<string, unknown>>) {
      if (!raw || typeof raw.title !== 'string' || typeof raw.kind !== 'string' || typeof raw.ref !== 'string') {
        return 'each tab needs title, kind and ref strings';
      }
      const id = typeof raw.id === 'string' && raw.id ? raw.id : tabIdFor(raw.title, taken);
      taken.add(id);
      out.push({ id, title: raw.title, kind: raw.kind, ref: raw.ref });
    }
    return out;
  }
  return `Unknown tabs verb "${verb}". Use add, rm, move or set.`;
}

/** A `dm` row as people see it: the personal space (My Kortix) or a private space with an agent. */
function privateSpaceName(agent: string): string {
  return agent === 'mykortix' || agent === 'meta' ? 'Your personal space' : `Private space with ${agent}`;
}

function writeSpace(space: Space): void {
  const name = space.kind === 'channel' ? `#${space.slug ?? space.name}` : privateSpaceName(space.dm_agent_name ?? space.name);
  process.stdout.write(`\n  ${C.bold}${name}${C.reset}  ${C.dim}${space.space_id}${C.reset}\n`);
  if (space.kind === 'channel') process.stdout.write(`  Name         ${space.name}\n`);
  process.stdout.write(`  Description  ${space.description ?? C.dim + '(none)' + C.reset}\n`);
  if (space.kind === 'channel') process.stdout.write(`  Agents       ${space.agents.length ? space.agents.join(', ') : C.dim + '(workspace default)' + C.reset}\n`);
  process.stdout.write(`  You may edit ${space.can_edit ? 'yes' : 'no'}\n`);
  writeTabs(space.tabs);
}

function writeTabs(tabs: readonly SpaceTab[]): void {
  process.stdout.write(`  Tabs         Chat${tabs.length ? '' : ` ${C.dim}(no other tabs)${C.reset}`}\n`);
  tabs.forEach((tab, i) => process.stdout.write(`    ${i + 1}. ${tab.title}  ${C.dim}${tab.kind} · ${tab.ref} · id ${tab.id}${C.reset}\n`));
  process.stdout.write('\n');
}

async function listSpaces(client: ApiClient, projectId: string): Promise<Space[]> {
  return (await client.get<{ spaces: Space[] }>(`/workspaces/${encodeURIComponent(projectId)}/spaces`)).spaces;
}

/** The space this command acts on: the named one, else the session's. */
async function resolveSpace(client: ApiClient, projectId: string, ref: string | undefined): Promise<Space | string> {
  const spaces = await listSpaces(client, projectId);
  if (ref) return findSpace(spaces, ref) ?? `No space "${ref}" in this workspace (or you may not see it). Run \`kortix spaces ls\`.`;
  const sessionId = process.env.KORTIX_SESSION_ID;
  if (!sessionId) return 'Name the space: kortix spaces <subcommand> <space>, or --space <space>.';
  const session = await client.get<{ space_id?: string | null }>(`/workspaces/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`);
  if (!session.space_id) return 'This session is filed in no space. Name one: --space <space>.';
  return spaces.find((s) => s.space_id === session.space_id) ?? 'The space of this session is not visible to you.';
}

/** User ids for emails or ids, through the project's member list. */
async function userIdsFor(client: ApiClient, projectId: string, refs: readonly string[]): Promise<string[] | string> {
  if (refs.every((r) => UUID.test(r))) return [...refs];
  const { members } = await client.get<{ members: Array<{ user_id: string; email: string | null }> }>(`/workspaces/${encodeURIComponent(projectId)}/access`);
  const out: string[] = [];
  for (const ref of refs) {
    if (UUID.test(ref)) {
      out.push(ref);
      continue;
    }
    const hit = members.find((m) => m.email?.toLowerCase() === ref.toLowerCase());
    if (!hit) return `No workspace member with the email ${ref}.`;
    out.push(hit.user_id);
  }
  return out;
}

export async function runSpaces(argv: string[]): Promise<number> {
  const helpExit = splitHelp(argv, HELP);
  if (helpExit !== null) return helpExit;
  const rest = [...argv];
  let flags: { space?: string; project?: string; host?: string; thread?: string };
  let json = false;
  let ask = false;
  try {
    flags = {
      space: takeFlagValue(rest, ['--space']),
      project: takeFlagValue(rest, ['--project', '--workspace']),
      host: takeFlagValue(rest, ['--host']),
      thread: takeFlagValue(rest, ['--thread']),
    };
    json = takeFlagBool(rest, ['--json']);
    ask = takeFlagBool(rest, ['--ask']);
  } catch (err) {
    return fail((err as Error).message);
  }
  const sub = rest.shift() ?? '';
  if (!(SUBCOMMANDS as readonly string[]).includes(sub)) return fail(`Unknown subcommand "${sub}". Run \`kortix spaces --help\`.`);
  const split = splitSpaceArg(sub, rest);
  const spaceRef = flags.space ?? split.space;
  const args = split.rest;

  const ctx = await resolveProjectContext({ projectArg: flags.project, hostArg: flags.host });
  if (!ctx) return 1;
  const { client, projectId } = ctx;
  const base = `/workspaces/${encodeURIComponent(projectId)}/spaces`;
  try {
    if (sub === 'ls' || sub === 'list') {
      const spaces = await listSpaces(client, projectId);
      if (json) return (emitJson({ spaces }), 0);
      for (const s of spaces) {
        // A private space prints its name and, dimmed, the ref that selects it (`dm:<agent>`).
        const label = s.kind === 'channel' ? `#${s.slug ?? s.name}` : privateSpaceName(s.dm_agent_name ?? '');
        const ref = s.kind === 'channel' ? '' : `  ${C.dim}dm:${s.dm_agent_name ?? ''}${C.reset}`;
        process.stdout.write(`  ${label.padEnd(28)} ${C.dim}${s.space_id}${C.reset}${ref}${s.description ? `  ${s.description}` : ''}\n`);
      }
      return 0;
    }
    const space = await resolveSpace(client, projectId, spaceRef);
    if (typeof space === 'string') return fail(space);
    const at = `${base}/${encodeURIComponent(space.space_id)}`;

    if (sub === 'get') {
      if (json) return (emitJson(space), 0);
      writeSpace(space);
      return 0;
    }
    if (sub === 'post') {
      const text = args.join(' ').trim();
      if (!text) return missing('the post text, e.g. kortix spaces post "The weather check is done."');
      if (ask && !flags.thread) return fail('--ask needs --thread <thread id>: a top-level post starts a new thread.');
      const posted = await client.post<{ session_id: string; kind: string; notified: string[]; mentions: Array<{ label: string }> }>(`${at}/posts`, {
        text,
        ...(flags.thread ? { thread_id: flags.thread } : {}),
        ...(ask ? { ask: true } : {}),
      });
      if (json) return (emitJson(posted), 0);
      const where = space.kind === 'channel' ? `#${space.slug ?? space.name}` : privateSpaceName(space.dm_agent_name ?? space.name).toLowerCase();
      process.stdout.write(`${status.ok(posted.kind === 'thread' ? `Posted in ${where} (thread ${posted.session_id})` : `Posted in thread ${posted.session_id}`)}\n`);
      if (posted.mentions.length) process.stdout.write(`  Mentioned ${posted.mentions.map((m) => m.label).join(', ')}; ${posted.notified.length} notified.\n`);
      return 0;
    }
    if (sub === 'rename' || sub === 'describe') {
      const text = args.join(' ');
      if (sub === 'rename' && !text.trim()) return missing('the new name, e.g. kortix spaces rename Launch');
      if (sub === 'describe' && args.length === 0) return missing('the description, e.g. kortix spaces describe "Everything for the launch"');
      const updated = await client.patch<Space>(at, sub === 'rename' ? { name: text.trim() } : { description: text.trim() });
      if (json) return (emitJson(updated), 0);
      process.stdout.write(`${status.ok(sub === 'rename' ? `Renamed to #${updated.slug ?? updated.name}` : 'Description set')}\n`);
      return 0;
    }
    if (sub === 'agents') {
      if (args[0] !== 'set') {
        if (json) return (emitJson({ agents: space.agents }), 0);
        process.stdout.write(`  ${space.agents.length ? space.agents.join(', ') : `${C.dim}(workspace default)${C.reset}`}\n`);
        return 0;
      }
      const updated = await client.patch<Space>(at, { agents: args.slice(1) });
      if (json) return (emitJson(updated), 0);
      process.stdout.write(`${status.ok(`Agents: ${updated.agents.length ? updated.agents.join(', ') : '(workspace default)'}`)}\n`);
      return 0;
    }
    if (sub === 'tabs') {
      if (args.length === 0) {
        if (json) return (emitJson({ tabs: space.tabs }), 0);
        writeTabs(space.tabs);
        return 0;
      }
      const next = editTabs(space.tabs, args[0]!, args.slice(1));
      if (typeof next === 'string') return fail(next);
      const updated = await client.put<Space>(`${at}/tabs`, { tabs: next });
      if (json) return (emitJson(updated), 0);
      writeTabs(updated.tabs);
      return 0;
    }
    // members
    const verb = args[0];
    if (!verb) {
      const list = await client.get<unknown>(`${at}/members`);
      if (json) return (emitJson(list), 0);
      for (const m of (list as { members: Array<{ user_id: string; name: string }> }).members) process.stdout.write(`  ${m.name}  ${C.dim}${m.user_id}${C.reset}\n`);
      return 0;
    }
    if (verb !== 'add' && verb !== 'rm' && verb !== 'remove') return fail(`Unknown members verb "${verb}". Use add or rm.`);
    const refs = args.slice(1);
    if (refs.length === 0) return missing(`members ${verb} <email|user id>`);
    const ids = await userIdsFor(client, projectId, refs);
    if (typeof ids === 'string') return fail(ids);
    const list = verb === 'add' ? await client.post<unknown>(`${at}/members`, { user_ids: ids }) : await client.delete<unknown>(`${at}/members/${encodeURIComponent(ids[0]!)}`);
    if (json) return (emitJson(list), 0);
    process.stdout.write(`${status.ok(verb === 'add' ? `Added ${ids.length}` : 'Removed')}\n`);
    return 0;
  } catch (err) {
    return surfaceApiError(err);
  }
}
