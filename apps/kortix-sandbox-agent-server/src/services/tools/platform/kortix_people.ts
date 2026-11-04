/**
 * kortix_people: the people of this project — who is in it and with which
 * role, invitations, and role changes. A project manager (or an account owner
 * or admin) may change them; anyone else gets a refusal that names who can.
 * A My Kortix platform tool (`platform.ts`): every action is one
 * `kortix access …` command.
 */
import { capRows, cliJson, cliRun, fail, memberName, ok, projectHref, projectRoster, cliArgProblem, type PlatformToolContext } from './platform'

const TOOL = 'kortix_people' as const
const ACTIONS = ['list', 'invite', 'set_role', 'remove', 'pending'] as const
const ROLES = ['manager', 'member'] as const

function roleWord(member: { account_role?: string | null; effective_project_role?: string | null }): string {
  if (member.account_role === 'owner' || member.account_role === 'admin') return member.account_role
  return member.effective_project_role ?? 'no access'
}

async function list(context: PlatformToolContext) {
  const roster = await projectRoster(context)
  if (roster === null) {
    const read = await cliJson(['access', 'ls', '--json'], context)
    return fail(TOOL, 'list', 'Could not list the people', 'error' in read ? read.error : { kind: 'failed', message: 'No member list.' }, context)
  }
  const members = roster.filter((member) => member.effective_project_role !== null || member.account_role === 'owner' || member.account_role === 'admin')
  return ok(
    TOOL,
    'list',
    {
      title: members.length === 1 ? '1 person' : `${members.length} people`,
      rows: capRows(members.map((member) => ({ title: memberName(member), ...(member.email && member.email !== memberName(member) ? { detail: member.email } : {}), badge: roleWord(member) }))),
      links: [{ label: 'Members', href: projectHref(context.env, '/members') }],
    },
    members.map((member) => ({ user_id: member.user_id, name: memberName(member), email: member.email ?? null, role: roleWord(member) })),
  )
}

async function pending(context: PlatformToolContext) {
  const read = await cliJson<{ invites?: Array<{ id?: string; email?: string; role?: string; expires_at?: string }> } | unknown[]>(['access', 'pending', '--json'], context)
  if ('error' in read) return fail(TOOL, 'pending', 'Could not list the invitations', read.error, context)
  const invites = (Array.isArray(read.value) ? read.value : (read.value.invites ?? [])) as Array<{ email?: string; role?: string }>
  return ok(
    TOOL,
    'pending',
    {
      title: invites.length === 1 ? '1 open invitation' : `${invites.length} open invitations`,
      rows: invites.map((invite) => ({ title: invite.email ?? 'invitation', ...(invite.role ? { badge: invite.role } : {}) })),
      links: [{ label: 'Members', href: projectHref(context.env, '/members') }],
    },
    read.value,
  )
}

/** A member by user id, email or name, from the roster. */
async function resolveMember(who: string, context: PlatformToolContext) {
  const roster = (await projectRoster(context)) ?? []
  const needle = who.toLowerCase()
  return roster.find((m) => m.user_id === who || m.email?.toLowerCase() === needle || memberName(m).toLowerCase() === needle) ?? null
}

async function invite(email: string, role: string, context: PlatformToolContext) {
  const sent = await cliRun(['access', 'invite', email, '--role', role], context)
  if ('error' in sent) return fail(TOOL, 'invite', `Could not invite ${email}`, sent.error, context)
  return ok(TOOL, 'invite', {
    title: `Invited ${email}`,
    subtitle: `As ${role}. The invitation is valid for 14 days.`,
    links: [{ label: 'Members', href: projectHref(context.env, '/members') }],
  })
}

async function setRole(who: string, role: string, context: PlatformToolContext) {
  const member = await resolveMember(who, context)
  if (!member?.user_id) return fail(TOOL, 'set_role', `Could not find ${who}`, { kind: 'not_found', message: `${who} is not a member of this project.` }, context)
  const done = await cliRun(['access', 'grant', member.user_id, '--role', role], context)
  if ('error' in done) return fail(TOOL, 'set_role', `Could not change ${memberName(member)}'s role`, done.error, context)
  return ok(TOOL, 'set_role', {
    title: `${memberName(member)} is now ${role}`,
    changes: [{ field: 'role', before: roleWord(member), after: role }],
    links: [{ label: 'Members', href: projectHref(context.env, '/members') }],
  })
}

async function remove(who: string, context: PlatformToolContext) {
  const member = await resolveMember(who, context)
  if (!member?.user_id) return fail(TOOL, 'remove', `Could not find ${who}`, { kind: 'not_found', message: `${who} is not a member of this project.` }, context)
  const done = await cliRun(['access', 'revoke', member.user_id], context)
  if ('error' in done) return fail(TOOL, 'remove', `Could not remove ${memberName(member)}`, done.error, context)
  return ok(TOOL, 'remove', { title: `Removed ${memberName(member)} from the project`, links: [{ label: 'Members', href: projectHref(context.env, '/members') }] })
}

export default {
  description:
    'The people of this project and their roles (manager or member; account owners and admins manage every project). ' +
    'Actions: `list`; `pending` (open invitations); `invite` (email, role); `set_role` (who: email, name or user id; role); `remove` (who). ' +
    'Inviting, changing a role and removing someone affect another person: say what will happen and ask once before you do it.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS], description: 'What to do.' },
      email: { type: 'string', description: 'For invite: their email address.' },
      who: { type: 'string', description: 'For set_role and remove: an email, a name or a user id.' },
      role: { type: 'string', enum: [...ROLES], description: 'For invite and set_role. Default member.' },
    },
    required: ['action'],
  },
  async execute(args: Record<string, any>, context: PlatformToolContext) {
    const action = String(args.action ?? '')
    const role = (ROLES as readonly string[]).includes(args.role) ? String(args.role) : 'member'
    const text = (key: string) => (typeof args[key] === 'string' ? args[key].trim() : '')
    if (action === 'list') return list(context)
    if (action === 'pending') return pending(context)
    const badEmail = action === 'invite' && text('email') ? cliArgProblem('email', text('email')) : null
    if (badEmail) return fail(TOOL, action, 'Who should I invite?', { kind: 'invalid', message: badEmail }, context)
    if (action === 'invite') return text('email') ? invite(text('email'), role, context) : fail(TOOL, action, 'Who should I invite?', { kind: 'invalid', message: 'Pass email.' }, context)
    if (action === 'set_role') return text('who') ? setRole(text('who'), role, context) : fail(TOOL, action, 'Whose role?', { kind: 'invalid', message: 'Pass who.' }, context)
    if (action === 'remove') return text('who') ? remove(text('who'), context) : fail(TOOL, action, 'Who should I remove?', { kind: 'invalid', message: 'Pass who.' }, context)
    return fail(TOOL, action, 'Unknown action', { kind: 'invalid', message: `Use one of: ${ACTIONS.join(', ')}.` }, context)
  },
}
