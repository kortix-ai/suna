import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, pad, status } from '../style.ts';

// Resource-access grants — the inheritance PYRAMID. Resources (secrets +
// connectors) live on AGENTS; you assign an agent to a member or department and
// they inherit everything that agent declares. This wraps the same
// /projects/:id/resource-grants routes the dashboard's "Members → Resource
// access" panel uses. Grantable resource types: agent, skill, secret.

const RESOURCE_TYPES = ['agent', 'skill', 'secret'] as const;
type ResourceType = (typeof RESOURCE_TYPES)[number];

interface GrantableAgent {
  id: string;
  name: string;
  declares?: { secrets: string[] | 'all'; connectors: string[] | 'all' };
}
interface GrantableResources {
  agents: GrantableAgent[];
  skills: { id: string; name: string }[];
  secrets: { id: string; name: string }[];
}
interface ResourceGrant {
  grant_id: string;
  resource_type: ResourceType;
  resource_id: string;
  principal_type: 'member' | 'group';
  principal_id: string;
  principal_label: string;
  granted_by: string | null;
  created_at: string;
  expires_at: string | null;
  orphaned: boolean;
}
interface GrantsResponse {
  resources: GrantableResources;
  grants: ResourceGrant[];
}

interface AccessMember {
  user_id: string;
  email: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HELP = `Usage: kortix grants <subcommand> [options]

Assign project resources to people — the inheritance PYRAMID. Secrets and
connectors live on AGENTS; assign an agent to a member (or department) and they
inherit everything that agent declares. Mirrors the dashboard's
"Members → Resource access" panel. Resource types: ${RESOURCE_TYPES.join(', ')}.

Subcommands:
  ls [--json]                          List grants + grantable agents/skills/secrets.
  assign <name> --to <who> [--group]   Assign a resource to a member (or --group department).
  revoke <grant-id>                    Remove a grant.

Options:
  --to <who>         Member email or user-id; department group-id with --group.
  --group            Treat --to as a department (group) id, not a member.
  --type <t>         ${RESOURCE_TYPES.join('|')} (default: agent).
  --expires <iso>    Optional auto-revoke timestamp (agents/skills only).
  --project <id>     Operate on this project id (default: linked).
  --host <name>      Operate against a non-default Kortix host.
  --json             Machine-readable output.
  -h, --help         Show this help.

Examples:
  kortix grants ls
  kortix grants assign support-bot --to alice@corp.com
  kortix grants assign support-bot --to 8f3c… --group
  kortix grants assign db-url --type secret --to alice@corp.com
  kortix grants revoke 2f1a…
`;

function missing(what: string): number {
  process.stderr.write(`${status.err(`Pass ${what}.`)}\n`);
  return 2;
}

/** Resolve a member's user-id from an email via the project access list. */
async function resolveMemberId(
  client: { get: <T>(p: string) => Promise<T> },
  base: string,
  who: string,
): Promise<string | null> {
  if (UUID_RE.test(who)) return who;
  const resp = await client.get<{ members: AccessMember[] }>(`${base}/access`);
  const needle = who.trim().toLowerCase();
  const hit = resp.members.find((m) => (m.email ?? '').toLowerCase() === needle);
  if (!hit) {
    process.stderr.write(
      `${status.err(`No member with email "${who}" in this project.`)} Use ${C.cyan}kortix access ls${C.reset} to see members, or pass a user-id.\n`,
    );
    return null;
  }
  return hit.user_id;
}

export async function runGrants(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }
  const sub = argv[0];
  const rest = argv.slice(1);
  const f: Record<string, string | undefined> = {};
  let json = false;
  let group = false;
  try {
    f.project = takeFlagValue(rest, ['--project']);
    f.host = takeFlagValue(rest, ['--host']);
    f.to = takeFlagValue(rest, ['--to']);
    f.type = takeFlagValue(rest, ['--type']);
    f.expires = takeFlagValue(rest, ['--expires']);
    json = takeFlagBool(rest, ['--json']);
    group = takeFlagBool(rest, ['--group']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const positional = rest.filter((a) => !a.startsWith('-'));
  const ctx = resolveProjectContext({ projectArg: f.project, hostArg: f.host });
  if (!ctx) return 1;
  const base = `/projects/${ctx.projectId}`;

  try {
    switch (sub) {
      case 'ls':
      case 'list': {
        const resp = await ctx.client.get<GrantsResponse>(`${base}/resource-grants`);
        if (json) {
          emitJson(resp);
          return 0;
        }
        const { agents, skills, secrets } = resp.resources;
        process.stdout.write('\n');
        process.stdout.write(`  ${C.dim}GRANTABLE${C.reset}\n`);
        if (agents.length === 0 && skills.length === 0 && secrets.length === 0) {
          process.stdout.write(
            `  ${C.faded}(none — add agents/skills to kortix.toml or secrets in the dashboard)${C.reset}\n`,
          );
        }
        for (const a of agents) {
          const decl = a.declares;
          const bits: string[] = [];
          if (decl) {
            const s =
              decl.secrets === 'all'
                ? 'all secrets'
                : `${decl.secrets.length} secret${decl.secrets.length === 1 ? '' : 's'}`;
            const co =
              decl.connectors === 'all'
                ? 'all connectors'
                : `${decl.connectors.length} connector${decl.connectors.length === 1 ? '' : 's'}`;
            bits.push(s, co);
          }
          process.stdout.write(
            `  ${C.cyan}agent${C.reset}   ${pad(a.name, 22)} ${C.faded}${bits.join(' · ')}${C.reset}\n`,
          );
        }
        for (const s of skills) process.stdout.write(`  ${C.cyan}skill${C.reset}   ${s.name}\n`);
        for (const s of secrets) process.stdout.write(`  ${C.cyan}secret${C.reset}  ${s.name}\n`);

        process.stdout.write(`\n  ${C.dim}GRANTS${C.reset}\n`);
        if (resp.grants.length === 0) {
          process.stdout.write(`  ${C.faded}(no assignments yet)${C.reset}\n\n`);
          return 0;
        }
        for (const g of resp.grants) {
          const flags = [
            g.orphaned ? `${C.red}(orphaned)${C.reset}` : '',
            g.expires_at ? `${C.faded}expires ${g.expires_at.slice(0, 10)}${C.reset}` : '',
          ]
            .filter(Boolean)
            .join(' ');
          process.stdout.write(
            `  ${pad(g.resource_type, 6)} ${C.bold}${pad(g.resource_id, 22)}${C.reset} → ${pad(`${g.principal_type === 'group' ? 'dept:' : ''}${g.principal_label}`, 26)} ${C.dim}${g.grant_id}${C.reset} ${flags}\n`,
          );
        }
        process.stdout.write(
          `\n  ${C.dim}${resp.grants.length} grant${resp.grants.length === 1 ? '' : 's'}${C.reset}\n\n`,
        );
        return 0;
      }

      case 'assign':
      case 'add': {
        const resourceId = positional[0];
        if (!resourceId) return missing('a resource name (agent/skill/secret)');
        if (!f.to) return missing('--to <member-email|user-id|group-id>');
        const resourceType = (f.type ?? 'agent') as ResourceType;
        if (!RESOURCE_TYPES.includes(resourceType)) {
          process.stderr.write(
            `${status.err(`--type must be one of ${RESOURCE_TYPES.join(', ')}`)}\n`,
          );
          return 2;
        }
        const principalType = group ? 'group' : 'member';
        // Members can be named by email (resolved here); groups must be an id
        // (the API validates it belongs to this account).
        let principalId = f.to;
        if (principalType === 'member') {
          const resolved = await resolveMemberId(ctx.client, base, f.to);
          if (!resolved) return 1;
          principalId = resolved;
        } else if (!UUID_RE.test(f.to)) {
          process.stderr.write(
            `${status.err('--group expects a department (group) id.')} Find it in the dashboard's Departments panel or via the API.\n`,
          );
          return 2;
        }
        const resp = await ctx.client.post<{ grant_id: string }>(`${base}/resource-grants`, {
          resource_type: resourceType,
          resource_id: resourceId,
          principal_type: principalType,
          principal_id: principalId,
          ...(f.expires ? { expires_at: f.expires } : {}),
        });
        if (json) {
          emitJson(resp);
          return 0;
        }
        const whoLabel = group ? `dept ${principalId}` : f.to;
        process.stdout.write(
          `${status.ok(`Assigned ${resourceType} ${C.bold}${resourceId}${C.reset} → ${C.bold}${whoLabel}${C.reset}`)}\n`,
        );
        if (resourceType === 'agent') {
          process.stdout.write(
            `  ${C.faded}They now inherit every secret + connector this agent declares.${C.reset}\n`,
          );
        }
        return 0;
      }

      case 'revoke':
      case 'rm':
      case 'delete': {
        const grantId = positional[0];
        if (!grantId) return missing('a grant id (see `kortix grants ls`)');
        await ctx.client.delete(`${base}/resource-grants/${encodeURIComponent(grantId)}`);
        process.stdout.write(`${status.ok(`Revoked grant ${C.bold}${grantId}${C.reset}`)}\n`);
        return 0;
      }

      default:
        process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    return surfaceApiError(err);
  }
}
