/**
 * Humanise audit-event action codes into readable titles + kind. Ported from
 * web components/iam/audit-display-helpers.ts (pure, no React). The colour map
 * uses hex (RN) instead of tailwind classes.
 */

export interface HumanizedAuditAction {
  title: string;
  detail?: string;
  kind: 'create' | 'update' | 'delete' | 'grant' | 'revoke' | 'attach' | 'detach' | 'read' | 'export' | 'other';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string): boolean => UUID_RE.test(s);

const IAM_ACTION_MAP: Record<string, { title: string; kind: HumanizedAuditAction['kind'] }> = {
  'iam.group.create': { title: 'Created group', kind: 'create' },
  'iam.group.update': { title: 'Updated group', kind: 'update' },
  'iam.group.delete': { title: 'Deleted group', kind: 'delete' },
  'iam.group.members.add': { title: 'Added member to group', kind: 'attach' },
  'iam.group.members.remove': { title: 'Removed member from group', kind: 'detach' },
  'iam.member.super_admin.grant': { title: 'Granted super-admin', kind: 'grant' },
  'iam.member.super_admin.revoke': { title: 'Revoked super-admin', kind: 'revoke' },
  'iam.member.role.change': { title: 'Changed member role', kind: 'update' },
  'iam.project.group.attach': { title: 'Attached group to project', kind: 'attach' },
  'iam.project.group.detach': { title: 'Detached group from project', kind: 'detach' },
  'iam.project.group.update': { title: 'Changed group role on project', kind: 'update' },
  'iam.member.invite': { title: 'Invited member', kind: 'create' },
  'iam.member.remove': { title: 'Removed member', kind: 'delete' },
  'iam.mfa_required.enable': { title: 'Required MFA for the account', kind: 'update' },
  'iam.mfa_required.disable': { title: 'Disabled MFA requirement', kind: 'update' },
  'iam.session_policy.update': { title: 'Updated session policy', kind: 'update' },
  'iam.pat_policy.update': { title: 'Updated PAT policy', kind: 'update' },
  'iam.sso.provider.update': { title: 'Updated SSO provider', kind: 'update' },
  'iam.sso.provider.delete': { title: 'Removed SSO provider', kind: 'delete' },
  'iam.sso.mapping.create': { title: 'Added SSO group mapping', kind: 'create' },
  'iam.sso.mapping.delete': { title: 'Removed SSO group mapping', kind: 'delete' },
  'iam.scim.token.create': { title: 'Created SCIM token', kind: 'create' },
  'iam.scim.token.revoke': { title: 'Revoked SCIM token', kind: 'revoke' },
  'iam.service_account.create': { title: 'Created service account', kind: 'create' },
  'iam.service_account.disable': { title: 'Disabled service account', kind: 'update' },
  'iam.service_account.delete': { title: 'Deleted service account', kind: 'delete' },
  'iam.audit.export': { title: 'Exported audit log', kind: 'export' },
  'iam.policy_template.apply': { title: 'Applied policy template', kind: 'grant' },
  'iam.policy.create': { title: 'Created IAM policy', kind: 'create' },
  'iam.policy.update': { title: 'Updated IAM policy', kind: 'update' },
  'iam.policy.delete': { title: 'Deleted IAM policy', kind: 'delete' },
};

type PathSegments = string[];
type HttpPatternHandler = (method: string, segs: PathSegments, rawPath: string) => HumanizedAuditAction | null;

const HTTP_PATTERNS: HttpPatternHandler[] = [
  (m, s) => {
    if (s[0] === 'projects' && s[2] === 'group-grants') {
      if (m === 'POST' && s.length === 3) return { title: 'Attached group to project', kind: 'attach' };
      if (m === 'PATCH' && s.length === 4) return { title: 'Changed group role on project', kind: 'update' };
      if (m === 'DELETE' && s.length === 4) return { title: 'Detached group from project', kind: 'detach' };
    }
    return null;
  },
  (m, s, raw) => {
    if (s[0] === 'projects' && s[2] === 'secrets') {
      const name = s[3] && s[3] !== ':id' ? s[3] : null;
      const personal = s[4] === 'personal';
      if (m === 'PUT') return { title: personal ? 'Set personal secret' : 'Set shared secret', detail: name ?? undefined, kind: 'update' };
      if (m === 'DELETE') return { title: personal ? 'Removed personal secret' : 'Removed shared secret', detail: name ?? undefined, kind: 'delete' };
      if (m === 'POST' && raw.endsWith(':rotate')) return { title: 'Rotated secret', detail: name ?? undefined, kind: 'update' };
      if (m === 'POST' && s.length === 3) return { title: 'Set project secret', kind: 'update' };
    }
    return null;
  },
  (m, s) => {
    if (s[0] === 'projects' && s[2] === 'access') {
      if (s[3] === 'pending-invites') {
        if (m === 'GET') return { title: 'Listed pending project invites', kind: 'read' };
        if (m === 'DELETE') return { title: 'Revoked pending project invitation', kind: 'revoke' };
      }
      if (m === 'POST' && s[3] === 'invite') return { title: 'Invited project member', kind: 'create' };
      if (m === 'PUT' && s.length === 4) return { title: 'Changed project member role', kind: 'update' };
      if (m === 'DELETE' && s.length === 4) return { title: 'Removed project member', kind: 'delete' };
    }
    return null;
  },
  (m, s) => {
    if (s[0] === 'projects' && s[2] === 'sessions') {
      const tail = s.slice(3);
      if (m === 'POST' && tail.length === 0) return { title: 'Started session', kind: 'create' };
      if (m === 'POST' && tail[1] === 'exec') return { title: 'Ran session command', kind: 'update' };
      if (m === 'POST' && tail[1] === 'stop') return { title: 'Stopped session', kind: 'update' };
      if (m === 'DELETE' && tail.length === 1) return { title: 'Deleted session', kind: 'delete' };
      if (m === 'PATCH' && tail.length === 1) return { title: 'Updated session', kind: 'update' };
    }
    return null;
  },
  (m, s) => {
    if (s[0] === 'projects' && s[2] === 'triggers') {
      if (m === 'POST' && s.length === 3) return { title: 'Created trigger', kind: 'create' };
      if (m === 'PATCH' && s.length === 4) return { title: 'Updated trigger', kind: 'update' };
      if (m === 'DELETE' && s.length === 4) return { title: 'Deleted trigger', kind: 'delete' };
      if (m === 'POST' && s[4] === 'fire') return { title: 'Fired trigger', kind: 'create' };
    }
    return null;
  },
  (m, s) => {
    if (s[0] === 'projects') {
      if (m === 'POST' && s.length === 1) return { title: 'Created project', kind: 'create' };
      if (m === 'PATCH' && s.length === 2) return { title: 'Updated project', kind: 'update' };
      if (m === 'DELETE' && s.length === 2) return { title: 'Deleted project', kind: 'delete' };
    }
    return null;
  },
  (m, s) => {
    if (s[0] === 'accounts' && s[2] === 'members') {
      if (m === 'POST' && s.length === 3) return { title: 'Added member to account', kind: 'create' };
      if (m === 'PATCH' && s.length === 4) return { title: 'Changed member role', kind: 'update' };
      if (m === 'DELETE' && s.length === 4) return { title: 'Removed member from account', kind: 'delete' };
    }
    return null;
  },
  (m, s) => {
    if (s[0] === 'accounts' && s.length === 2) {
      if (m === 'PATCH') return { title: 'Updated account settings', kind: 'update' };
      if (m === 'DELETE') return { title: 'Deleted account', kind: 'delete' };
    }
    return null;
  },
  (m, s) => {
    if (s[0] === 'accounts' && s[2] === 'iam' && s[3] === 'policy-templates') {
      const slug = s[4] && s[4] !== ':id' ? s[4] : null;
      if (m === 'POST' && s[5] === 'apply') return { title: 'Applied policy template', detail: slug ?? undefined, kind: 'grant' };
      if (m === 'GET') return { title: 'Listed policy templates', kind: 'read' };
    }
    return null;
  },
  (m, s) => {
    if (s[0] === 'accounts' && s[2] === 'iam' && s[3] === 'policies') {
      if (m === 'POST' && s.length === 4) return { title: 'Created IAM policy', kind: 'create' };
      if (m === 'PATCH' && s.length === 5) return { title: 'Updated IAM policy', kind: 'update' };
      if (m === 'DELETE' && s.length === 5) return { title: 'Deleted IAM policy', kind: 'delete' };
      if (m === 'GET') return { title: 'Listed IAM policies', kind: 'read' };
    }
    return null;
  },
  (m, s) => {
    if (s[0] === 'accounts' && s[2] === 'iam' && s[3] === 'members') {
      const tail = s.slice(4);
      if (tail[1] === 'super-admin') return { title: 'Set super-admin status', kind: 'grant' };
      if (tail[1] === 'project-access') return { title: 'Listed project access', kind: 'read' };
      if (tail[1] === 'groups') return { title: 'Listed member groups', kind: 'read' };
      if (tail[1]?.startsWith('effective')) return { title: 'Checked effective permissions', kind: 'read' };
      if (tail[1] === 'boundary') return { title: 'Updated permission boundary', kind: 'update' };
    }
    return null;
  },
  (m, s) => {
    if (s[0] === 'accounts' && s[2] === 'iam' && s[3] === 'groups') {
      const tail = s.slice(4);
      if (m === 'POST' && tail.length === 0) return { title: 'Created group', kind: 'create' };
      if (m === 'PATCH' && tail.length === 1) return { title: 'Updated group', kind: 'update' };
      if (m === 'DELETE' && tail.length === 1) return { title: 'Deleted group', kind: 'delete' };
      if (tail[1] === 'members') {
        if (m === 'POST') return { title: 'Added member to group', kind: 'attach' };
        if (m === 'DELETE') return { title: 'Removed member from group', kind: 'detach' };
      }
      if (tail[1] === 'project-grants') return { title: 'Listed group project access', kind: 'read' };
    }
    return null;
  },
  (m, s) => {
    if (s[0] === 'accounts' && s[2] === 'iam') {
      if (s[3] === 'mfa-required' && m === 'PATCH') return { title: 'Changed MFA requirement', kind: 'update' };
      if (s[3] === 'session-policy' && m === 'PATCH') return { title: 'Updated session policy', kind: 'update' };
      if (s[3] === 'sessions' && s[5] === 'revoke') return { title: 'Revoked session', kind: 'revoke' };
      if (s[3] === 'pat-policy' && m === 'PATCH') return { title: 'Updated PAT policy', kind: 'update' };
      if (s[3] === 'sso' && s[4] === 'provider') {
        if (m === 'PUT') return { title: 'Updated SSO provider', kind: 'update' };
        if (m === 'DELETE') return { title: 'Removed SSO provider', kind: 'delete' };
      }
      if (s[3] === 'sso' && s[4] === 'mappings') {
        if (m === 'POST') return { title: 'Added SSO group mapping', kind: 'create' };
        if (m === 'DELETE') return { title: 'Removed SSO group mapping', kind: 'delete' };
      }
      if (s[3] === 'scim' && s[4] === 'tokens') {
        if (m === 'POST') return { title: 'Created SCIM token', kind: 'create' };
        if (m === 'DELETE') return { title: 'Revoked SCIM token', kind: 'revoke' };
      }
      if (s[3] === 'service-accounts') {
        if (m === 'POST' && s.length === 4) return { title: 'Created service account', kind: 'create' };
        if (s[5] === 'disable') return { title: 'Disabled service account', kind: 'update' };
        if (m === 'DELETE' && s.length === 5) return { title: 'Deleted service account', kind: 'delete' };
      }
    }
    return null;
  },
  (m, s) => {
    if (s[0] === 'accounts' && s[2] === 'audit' && s[3] === 'export') return { title: 'Exported audit log', kind: 'export' };
    return null;
  },
];

export function humanizeAuditAction(action: string): HumanizedAuditAction {
  const iam = IAM_ACTION_MAP[action];
  if (iam) return { title: iam.title, kind: iam.kind };

  const httpMatch = action.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+)$/);
  if (httpMatch) {
    const method = httpMatch[1];
    const rawPath = httpMatch[2];
    const path = rawPath.split('?')[0];
    const tail = path.replace(/^\/v1\/?/, '');
    if (!tail) return { title: `${method} /v1`, kind: 'other' };
    const segments = tail.split('/').map((seg) => (isUuid(seg) ? ':id' : seg));
    for (const handler of HTTP_PATTERNS) {
      const out = handler(method, segments, path);
      if (out) return out;
    }
    return { title: `${method} ${path.replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '/…')}`, kind: kindFromMethod(method) };
  }
  return { title: action, kind: 'other' };
}

function kindFromMethod(method: string): HumanizedAuditAction['kind'] {
  switch (method) {
    case 'POST':
      return 'create';
    case 'PUT':
    case 'PATCH':
      return 'update';
    case 'DELETE':
      return 'delete';
    default:
      return 'other';
  }
}

export function formatResourcePill(resourceType: string | null | undefined, resourceId: string | null | undefined): string | null {
  if (!resourceType) return null;
  const label = resourceType.replace(/_/g, ' ');
  const short = resourceId ? resourceId.slice(0, 8) : null;
  return short ? `${label} · ${short}` : label;
}

export const KIND_DOT_COLOR: Record<HumanizedAuditAction['kind'], string> = {
  create: '#22c55e',
  update: '#f59e0b',
  delete: '#f43f5e',
  grant: '#8b5cf6',
  revoke: '#f43f5e',
  attach: '#0ea5e9',
  detach: '#a1a1aa',
  read: '#a1a1aa',
  export: '#0ea5e9',
  other: '#a1a1aa',
};
