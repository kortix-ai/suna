import { ApiError } from './api/client.ts';
import { surfaceApiError } from './command-helpers.ts';
import { C, status } from './style.ts';

/**
 * Next steps for the connector policy-set error codes (connectors/routes/
 * settings.ts, projects/routes/agent-scope.ts). The server's sentence names
 * what failed; the hint names the command that fixes it. Any other error
 * falls through to `surfaceApiError`.
 */
export function surfacePolicySetError(
  err: unknown,
  ctx: { slug?: string; agent?: string } = {},
): number {
  const body = err instanceof ApiError ? (err.body as { code?: unknown; agents?: unknown } | null) : null;
  const rawCode = typeof body?.code === 'string' ? body.code : null;
  // The scope route reports an unknown set through the manifest validator
  // (`invalid_scope`, issue path `agents.<a>.policy_sets.<slug>`).
  const code =
    rawCode === 'invalid_scope' && /\.policy_sets\./.test((err as Error).message ?? '')
      ? 'policy_set_not_found'
      : rawCode;
  const slug = ctx.slug ?? '<slug>';
  const hint = code ? policySetHint(code, slug, ctx.agent, body) : null;
  if (!hint) return surfaceApiError(err);
  process.stderr.write(`${status.err((err as Error).message || code!)}\n`);
  for (const line of hint) process.stderr.write(`  ${C.dim}${line}${C.reset}\n`);
  return 1;
}

function policySetHint(
  code: string,
  slug: string,
  agent: string | undefined,
  body: { agents?: unknown } | null,
): string[] | null {
  switch (code) {
    case 'policy_set_not_found':
      return [
        `List the sets: kortix connectors policy-sets ${slug} ls`,
        `Create one:    kortix connectors policy-sets ${slug} create <name>`,
      ];
    case 'invalid_policy_set_name':
      return ['A set name is 1-64 of a-z, 0-9, - and _, starting with a letter or digit. "base" is reserved.'];
    case 'policy_set_exists':
      return [`Pick another name, or remove that set first: kortix connectors policy-sets ${slug} rm <name>`];
    case 'policy_set_limit':
      return ['A connector holds at most 32 policy sets. Remove one first.'];
    case 'policy_sets_unsupported':
      return ['Channel and Computer connectors have no kortix.yaml entry, so they cannot hold policy sets.'];
    case 'unsupported_in_v1':
      return ['Policy sets need kortix.yaml (kortix_version 2 or 3). Migrate: kortix migrate'];
    case 'use_policies_route':
      return [`Write a set's rules with: kortix connectors policy ${slug} --policy-set <name> set <match> <action>`];
    case 'connector_not_granted':
      return [
        `Grant the connector first: kortix agents scope ${agent ?? '<agent>'} --connectors <slugs>`,
      ];
    case 'connector_not_found':
      return ['List the connectors: kortix connectors ls'];
    case 'policy_set_in_use': {
      const agents = Array.isArray(body?.agents) ? body.agents.map(String) : [];
      return [
        ...(agents.length ? [`Used by: ${agents.join(', ')}`] : []),
        `Move each agent to base rules first: kortix agents scope ${agents[0] ?? '<agent>'} --policy-set ${slug}=base`,
      ];
    }
    default:
      return null;
  }
}
