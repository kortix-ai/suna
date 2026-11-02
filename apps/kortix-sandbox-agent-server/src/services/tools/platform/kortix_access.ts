/**
 * kortix_access: what the person may do here, and who can grant what they may
 * not. My Kortix acts with exactly the person's own rights, so "what can you
 * do?" and "what can I do?" have one answer. A My Kortix platform tool
 * (`platform.ts`): `kortix whoami` and `kortix access ls`.
 */
import { cliJson, fail, ok, projectHref, projectId, projectManagers, projectRoster, type PlatformToolContext } from './platform'

const TOOL = 'kortix_access' as const
const ACTIONS = ['me', 'who_can_grant'] as const

interface Me {
  user_id?: string
  email?: string
  accounts?: Array<{ account_id?: string; name?: string; role?: string; account_role?: string }>
}

async function me(context: PlatformToolContext) {
  const read = await cliJson<Me>(['whoami', '--json'], context)
  if ('error' in read) return fail(TOOL, 'me', 'Could not read your access', read.error, context)
  const roster = (await projectRoster(context)) ?? []
  const self = roster.find((member) => member.user_id === read.value.user_id)
  const accountRole = self?.account_role ?? read.value.accounts?.[0]?.role ?? read.value.accounts?.[0]?.account_role ?? null
  const projectRole = accountRole === 'owner' || accountRole === 'admin' ? 'manager' : (self?.effective_project_role ?? null)
  const manages = projectRole === 'manager'
  return ok(
    TOOL,
    'me',
    {
      title: manages ? 'You manage this project' : projectRole ? `You are a ${projectRole} of this project` : 'You have limited access here',
      subtitle: manages
        ? 'You can change its agents, connectors, schedules and people. So can I, for you.'
        : 'You can use its agents and start work. Changing its settings needs a project manager.',
      rows: [
        ...(read.value.email ? [{ title: 'Signed in as', detail: read.value.email }] : []),
        ...(accountRole ? [{ title: 'Account role', detail: accountRole }] : []),
        ...(projectRole ? [{ title: 'Project role', detail: projectRole }] : []),
      ],
      links: [{ label: 'Members', href: projectHref(context.env, '/members') }],
    },
    { email: read.value.email ?? null, account_role: accountRole, project_role: projectRole, project_id: projectId(context.env) },
  )
}

async function whoCanGrant(context: PlatformToolContext) {
  const managers = await projectManagers(context)
  return ok(
    TOOL,
    'who_can_grant',
    {
      title: managers.length === 0 ? 'No project manager is visible to you' : managers.length === 1 ? '1 person can grant access' : `${managers.length} people can grant access`,
      rows: managers.map((manager) => ({ title: manager.name, badge: manager.role })),
      links: [{ label: 'Members', href: projectHref(context.env, '/members') }],
    },
    { grantors: managers },
  )
}

export default {
  description:
    'What the person may do in this project, and who can grant more. You act with exactly their rights. ' +
    'Actions: `me` (their account and project role); `who_can_grant` (the project managers, account owners and admins). ' +
    'When another tool is refused, its result already names who can grant it.',
  parameters: {
    type: 'object',
    properties: { action: { type: 'string', enum: [...ACTIONS], description: 'What to read.' } },
    required: ['action'],
  },
  async execute(args: Record<string, any>, context: PlatformToolContext) {
    const action = String(args.action ?? '')
    if (action === 'me') return me(context)
    if (action === 'who_can_grant') return whoCanGrant(context)
    return fail(TOOL, action, 'Unknown action', { kind: 'invalid', message: `Use one of: ${ACTIONS.join(', ')}.` }, context)
  },
}
