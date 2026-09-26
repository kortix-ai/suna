import type { UiTranslator } from '@/i18n/translator';
import {
  auditFamilyDetail,
  auditLabelForAction,
  auditLabelForRoute,
  auditRouteForAction,
} from '@kortix/shared/audit-labels';

import { AUDIT_HTTP_ROUTES } from './audit-http-routes.generated';
import { AUDIT_TITLE_TRANSLATION_KEYS } from './audit-title-translation-keys.generated';

export { AUDIT_HTTP_ROUTES } from './audit-http-routes.generated';

// Humanise audit-event actions into "Revoked LLM gateway key" style titles.
// The titles come from `@kortix/shared/audit-labels`, the one catalog the
// API writes from: every route has a label (`gateway.key.revoke`), and every
// event a writer records outside a route has a title. Rows carry:
//
//   1. A label action (`gateway.key.revoke`, `secret.consumer.used`). Direct
//      catalog lookup; a `.*` family (`connector.*`) adds its tail as detail.
//
//   2. Older named actions (`iam.member.super_admin.grant`) the catalog no
//      longer lists. `IAM_ACTION_MAP` below.
//
//   3. Rows written before labels existed: the request line
//      (`POST /v1/projects/:projectId/group-grants`, or a raw path on the
//      oldest rows). The matched route's catalog title, plus any detail the
//      path patterns below read from a raw path.
//
// Pure helpers (no React) so the audit row stays test-friendly. Lives
// in components/iam so it can be unit-tested alongside the other V2
// display helpers.

export interface HumanizedAuditAction {
  /** Short imperative verb, e.g. "Created group". */
  title: string;
  /** Optional secondary descriptor, e.g. the resource name parsed
   *  from the path. Renders next to the title. */
  detail?: string;
  /** Coarse category for the row's icon / colour accent. */
  kind:
    | 'create'
    | 'update'
    | 'delete'
    | 'grant'
    | 'revoke'
    | 'attach'
    | 'detach'
    | 'read'
    | 'export'
    | 'other';
}

export interface AuditActionDescription extends HumanizedAuditAction {
  /** True when a named action or API route produced the label. */
  mapped: boolean;
  /** HTTP method for request actions. */
  method: string | null;
  /** Manifest route template for request actions. */
  route: string | null;
  /** Short product area for the row subtitle. */
  area: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string): boolean => UUID_RE.test(s);

interface RouteMatcher {
  method: string;
  path: string;
  pattern: RegExp;
  specificity: number;
}

const HTTP_ROUTE_MATCHERS: RouteMatcher[] = AUDIT_HTTP_ROUTES.map((signature) => {
  const separator = signature.indexOf(' ');
  const method = signature.slice(0, separator);
  const path = signature.slice(separator + 1);
  const parts = path.split('/');
  const specificity = parts.filter((part) => part && !part.startsWith(':')).length;
  const source = parts
    .map((part) => (part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return { method, path, pattern: new RegExp(`^${source}/?$`), specificity };
}).sort(
  (left, right) => right.specificity - left.specificity || right.path.length - left.path.length,
);

const IAM_ACTION_MAP: Record<string, { title: string; kind: HumanizedAuditAction['kind'] }> = {
  'admin.account.session_limit.set': { title: 'Updated account session limit', kind: 'update' },
  'admin.account.tier.set': { title: 'Updated account tier', kind: 'update' },
  'auth.login.fail': { title: 'Failed to sign in', kind: 'other' },
  'auth.login.success': { title: 'Signed in', kind: 'read' },
  'auth.logout': { title: 'Signed out', kind: 'read' },
  'auth.session.first_sight': { title: 'Started authenticated session', kind: 'create' },
  'enterprise_demo.disable': { title: 'Disabled Enterprise preview', kind: 'update' },
  'enterprise_demo.enable': { title: 'Enabled Enterprise preview', kind: 'update' },
  'iam.audit.webhook.create': { title: 'Created audit webhook', kind: 'create' },
  'iam.audit.webhook.delete': { title: 'Deleted audit webhook', kind: 'delete' },
  'iam.audit.webhook.update': { title: 'Updated audit webhook', kind: 'update' },
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
  'iam.project.group.expired': { title: 'Expired project group access', kind: 'revoke' },
  'iam.project.group.update': { title: 'Changed group role on project', kind: 'update' },
  'iam.project.member.expired': { title: 'Expired project member access', kind: 'revoke' },
  'iam.member.invite': { title: 'Invited member', kind: 'create' },
  'iam.member.remove': { title: 'Removed member', kind: 'delete' },
  'iam.mfa_required.enable': { title: 'Required MFA for the account', kind: 'update' },
  'iam.mfa_required.disable': { title: 'Disabled MFA requirement', kind: 'update' },
  'iam.session_oversight.enable': { title: 'Let admins open every session', kind: 'update' },
  'iam.session_oversight.disable': { title: 'Stopped admins opening every session', kind: 'update' },
  'iam.session_policy.update': { title: 'Updated session policy', kind: 'update' },
  'iam.pat_policy.update': { title: 'Updated PAT policy', kind: 'update' },
  'iam.sso.provider.update': { title: 'Updated SSO provider', kind: 'update' },
  'iam.sso.provider.create': { title: 'Created SSO provider', kind: 'create' },
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
  // These were briefly dead (V1 policies removed in PR5) but a DB-backed
  // custom-role/policy surface was rebuilt in Phase 3 of feat/iam-rbac-v1
  // (June 2026, accounts/iam/custom-roles.ts) at the same action codes —
  // this map now covers LIVE activity again, not just historical rows.
  'iam.policy.create': { title: 'Created IAM policy', kind: 'create' },
  'iam.policy.update': { title: 'Updated IAM policy', kind: 'update' },
  'iam.policy.delete': { title: 'Deleted IAM policy', kind: 'delete' },
  'iam.policy.bulk_import': { title: 'Bulk imported IAM policies', kind: 'create' },
  'iam.role.create': { title: 'Created IAM role', kind: 'create' },
  'iam.role.delete': { title: 'Deleted IAM role', kind: 'delete' },
  'iam.role.permissions.set': { title: 'Updated IAM role permissions', kind: 'update' },
  'iam.session.revoke': { title: 'Revoked account session', kind: 'revoke' },
  'project.admin_bypass_read': { title: 'Used admin bypass to view project', kind: 'read' },
  'project.admin_bypass_session_read': {
    title: 'Used admin bypass to view session',
    kind: 'read',
  },
  'project.admin_oversight_session_read': {
    title: 'Opened a member session as account admin',
    kind: 'read',
  },
  'project.connector.read': { title: 'Read project connector', kind: 'read' },
  'scim.group.create': { title: 'Provisioned SCIM group', kind: 'create' },
  'scim.group.delete': { title: 'Deleted SCIM group', kind: 'delete' },
  'scim.group.update': { title: 'Updated SCIM group', kind: 'update' },
  'scim.user.deactivate': { title: 'Deactivated SCIM user', kind: 'revoke' },
  'scim.user.delete': { title: 'Deleted SCIM user', kind: 'delete' },
  'scim.user.invite': { title: 'Invited SCIM user', kind: 'create' },
  'scim.user.invite_revoke': { title: 'Revoked SCIM user invitation', kind: 'revoke' },
  'webhook.test': { title: 'Sent audit webhook test', kind: 'update' },
};

// ─── HTTP path patterns ──────────────────────────────────────────────────
//
// Each entry checks against (method, segments) of the parsed path. First
// match wins. `segments` is the path after /v1/ with UUIDs replaced by
// the literal token `:id`, so e.g.
//   POST /v1/projects/abc-…/group-grants
// becomes segments ["projects", ":id", "group-grants"]

type PathSegments = string[];
type HttpPatternHandler = (
  method: string,
  segs: PathSegments,
  rawPath: string,
) => HumanizedAuditAction | null;

function httpPatterns(tI18nComplete: UiTranslator): HttpPatternHandler[] {
  return [
    // ── Project group-grants ─────────────────────────────────────────
    (m, s) => {
      if (s[0] === 'projects' && s[2] === 'group-grants') {
        if (m === 'POST' && s.length === 3)
          return { title: tI18nComplete.raw('text24a754cf2e81'), kind: 'attach' };
        if (m === 'PATCH' && s.length === 4)
          return { title: tI18nComplete.raw('text84b78c923b6a'), kind: 'update' };
        if (m === 'DELETE' && s.length === 4)
          return { title: tI18nComplete.raw('text4891f0add1ec'), kind: 'detach' };
      }
      return null;
    },
    // ── Project secrets ──────────────────────────────────────────────
    (m, s, raw) => {
      if (s[0] === 'projects' && s[2] === 'secrets') {
        // /v1/projects/:id/secrets/NAME[/personal]
        const name = s[3] && s[3] !== ':id' ? s[3] : null;
        const personal = s[4] === 'personal';
        if (m === 'PUT' && s[4] === 'strategy') {
          return {
            title: tI18nComplete.raw('text78992a9b4a8f'),
            detail: name ?? undefined,
            kind: 'update',
          };
        }
        if (m === 'PUT') {
          return {
            title: personal ? 'Set personal secret' : 'Set shared secret',
            detail: name ?? undefined,
            kind: 'update',
          };
        }
        if (m === 'DELETE') {
          return {
            title: personal ? 'Removed personal secret' : 'Removed shared secret',
            detail: name ?? undefined,
            kind: 'delete',
          };
        }
        if (m === 'POST' && raw.endsWith(':rotate')) {
          return {
            title: tI18nComplete.raw('textf7d383dc224d'),
            detail: name ?? undefined,
            kind: 'update',
          };
        }
        if (m === 'POST' && s[4] === 'grant') {
          // Writes the agent's `secrets:` list in kortix.yaml, so it widens what a
          // session can reach — an access change, not a value change.
          return {
            title: tI18nComplete.raw('textfdcd7d7a2b54'),
            detail: name ?? undefined,
            kind: 'update',
          };
        }
        // POST /v1/projects/:id/secrets with name in body (not in path).
        // The name isn't recoverable from the URL so we just label the
        // action and rely on the before/after diff for the detail.
        if (m === 'POST' && s.length === 3) {
          return { title: tI18nComplete.raw('textb61c8415b2b6'), kind: 'update' };
        }
      }
      return null;
    },
    // ── Project access (direct members + pending invites) ───────────
    (m, s) => {
      if (s[0] === 'projects' && s[2] === 'access') {
        // Bootstrap-grant pending-invite endpoints. The DELETE is the
        // Revoke action on the Pending Invitations card.
        if (s[3] === 'pending-invites') {
          if (m === 'GET') return { title: tI18nComplete.raw('textf7870941f5a8'), kind: 'read' };
          if (m === 'DELETE')
            return { title: tI18nComplete.raw('textad5c82071432'), kind: 'revoke' };
        }
        if (m === 'POST' && s[3] === 'invite')
          return { title: tI18nComplete.raw('text69396637a410'), kind: 'create' };
        if (m === 'PUT' && s.length === 4)
          return { title: tI18nComplete.raw('text2b99e2a42352'), kind: 'update' };
        if (m === 'DELETE' && s.length === 4)
          return { title: tI18nComplete.raw('texta4c9215859a8'), kind: 'delete' };
      }
      return null;
    },
    // ── Project sessions ─────────────────────────────────────────────
    // POST /v1/projects/:id/sessions[/:sessionId/...] — every interactive
    // run lands here, so we get a lot of these. Friendly title beats raw
    // method+path in a long audit list.
    (m, s) => {
      if (s[0] === 'projects' && s[2] === 'sessions') {
        const tail = s.slice(3); // after /sessions
        if (m === 'POST' && tail.length === 0)
          return { title: tI18nComplete.raw('text1f2cde4f0d46'), kind: 'create' };
        if (m === 'POST' && tail[1] === 'exec')
          return { title: tI18nComplete.raw('textc0d5cbb786f3'), kind: 'update' };
        if (m === 'POST' && tail[1] === 'stop')
          return { title: tI18nComplete.raw('text4e7b0cd1a437'), kind: 'update' };
        if (m === 'DELETE' && tail.length === 1)
          return { title: tI18nComplete.raw('text06c4ea480765'), kind: 'delete' };
        if (m === 'PATCH' && tail.length === 1)
          return { title: tI18nComplete.raw('text8bfaeec7acfe'), kind: 'update' };
      }
      return null;
    },
    // ── Project triggers ─────────────────────────────────────────────
    (m, s) => {
      if (s[0] === 'projects' && s[2] === 'triggers') {
        if (m === 'POST' && s.length === 3)
          return { title: tI18nComplete.raw('text7bc57426b2fa'), kind: 'create' };
        if (m === 'PATCH' && s.length === 4)
          return { title: tI18nComplete.raw('text1d2a6194e5b0'), kind: 'update' };
        if (m === 'DELETE' && s.length === 4)
          return { title: tI18nComplete.raw('text38438f131ca0'), kind: 'delete' };
        if (m === 'POST' && s[4] === 'fire')
          return { title: tI18nComplete.raw('text183bd99db5b3'), kind: 'create' };
      }
      // Monitor event intake — the project monitor box appending to its event
      // log (sandbox-token-only; see docs/specs/2026-08-12-monitors.md).
      if (s[0] === 'projects' && s[2] === 'monitors' && s[3] === 'ingest' && m === 'POST') {
        return { title: tI18nComplete.raw('text6201f8d3134e'), kind: 'create' };
      }
      return null;
    },
    // ── Project lifecycle ────────────────────────────────────────────
    (m, s) => {
      if (s[0] === 'projects') {
        if (m === 'POST' && s.length === 1)
          return { title: tI18nComplete.raw('text79ffe7bf8192'), kind: 'create' };
        if (m === 'PATCH' && s.length === 2)
          return { title: tI18nComplete.raw('text4ad32e5b8e19'), kind: 'update' };
        if (m === 'DELETE' && s.length === 2)
          return { title: tI18nComplete.raw('textb39d263f67ad'), kind: 'delete' };
      }
      return null;
    },
    // ── Account members ──────────────────────────────────────────────
    (m, s) => {
      if (s[0] === 'accounts' && s[2] === 'members') {
        if (m === 'POST' && s.length === 3)
          return { title: tI18nComplete.raw('texte4f5f1e08c59'), kind: 'create' };
        if (m === 'PATCH' && s.length === 4)
          return { title: tI18nComplete.raw('text3e820fc2d91f'), kind: 'update' };
        if (m === 'DELETE' && s.length === 4)
          return { title: tI18nComplete.raw('texted41f8758db3'), kind: 'delete' };
      }
      return null;
    },
    // ── Account lifecycle (name/description edits) ───────────────────
    // PATCH /v1/accounts/:id — used by the account settings form. Without
    // this the audit log shows a bare "PATCH /v1/accounts/{id}" that
    // tells the reader nothing.
    (m, s) => {
      if (s[0] === 'accounts' && s.length === 2) {
        if (m === 'PATCH') return { title: tI18nComplete.raw('textc2c989a90482'), kind: 'update' };
        if (m === 'DELETE') return { title: tI18nComplete.raw('textefb5b201f3c6'), kind: 'delete' };
      }
      return null;
    },
    // ── IAM policy templates ─────────────────────────────────────────
    // Templates are baked-in role bundles ("project-readonly-auditor",
    // "billing-only", etc) — applying one creates the underlying group
    // grants in a single shot, so we surface both the verb and which
    // template was applied.
    (m, s) => {
      if (s[0] === 'accounts' && s[2] === 'iam' && s[3] === 'policy-templates') {
        const slug = s[4] && s[4] !== ':id' ? s[4] : null;
        if (m === 'POST' && s[5] === 'apply')
          return {
            title: tI18nComplete.raw('textab2f1e5b956a'),
            detail: slug ?? undefined,
            kind: 'grant',
          };
        if (m === 'GET') return { title: tI18nComplete.raw('text57c848e1ca75'), kind: 'read' };
      }
      return null;
    },
    // ── Role assignments + the permission catalog ────────────────────
    // The canonical grant surface: ONE row per (principal, role, scope, object).
    // It replaced the five endpoint families below, which stay mapped while they
    // dual-write.
    (m, s) => {
      if (s[0] === 'accounts' && s[2] === 'iam' && s[3] === 'assignments') {
        if (m === 'POST') return { title: tI18nComplete.raw('texta21492a5bd01'), kind: 'grant' };
        if (m === 'DELETE') return { title: tI18nComplete.raw('texte75eb1c6178c'), kind: 'revoke' };
        if (m === 'GET') return { title: tI18nComplete.raw('text548677c5771e'), kind: 'read' };
      }
      if (s[0] === 'accounts' && s[2] === 'iam' && s[3] === 'permissions' && m === 'GET') {
        return { title: tI18nComplete.raw('text5122577b6042'), kind: 'read' };
      }
      return null;
    },
    // ── IAM policies (bare /iam/policies endpoints) ──────────────────
    // Fallback for rows logged as the raw HTTP path rather than a specific
    // iam.policy.* code (e.g. applying a policy template, or older rows from
    // before the direct action-code logging existed). The policies surface
    // itself is live (custom-roles.ts, Phase 3 of feat/iam-rbac-v1) — this
    // isn't legacy-only. Map them so the log doesn't show raw curl commands.
    (m, s) => {
      if (s[0] === 'accounts' && s[2] === 'iam' && s[3] === 'policies') {
        if (m === 'POST' && s.length === 4)
          return { title: tI18nComplete.raw('textf58f153c56ed'), kind: 'create' };
        if (m === 'PATCH' && s.length === 5)
          return { title: tI18nComplete.raw('text720878394def'), kind: 'update' };
        if (m === 'DELETE' && s.length === 5)
          return { title: tI18nComplete.raw('textbb4db6a8ee1a'), kind: 'delete' };
        if (m === 'GET') return { title: tI18nComplete.raw('texte7b9a6c97fc7'), kind: 'read' };
      }
      return null;
    },
    // ── IAM members (super-admin, groups, project access, effective probe) ──
    (m, s) => {
      if (s[0] === 'accounts' && s[2] === 'iam' && s[3] === 'members') {
        const tail = s.slice(4); // after /members/:userId
        if (tail[1] === 'super-admin')
          return { title: tI18nComplete.raw('text2bc95eda6944'), kind: 'grant' };
        if (tail[1] === 'project-access')
          return { title: tI18nComplete.raw('text6dead34f47ed'), kind: 'read' };
        if (tail[1] === 'groups')
          return { title: tI18nComplete.raw('texta5437897f3e7'), kind: 'read' };
        if (tail[1]?.startsWith('effective'))
          return { title: tI18nComplete.raw('text3ecb3ffd4f33'), kind: 'read' };
        if (tail[1] === 'boundary')
          return { title: tI18nComplete.raw('textea5453721f2c'), kind: 'update' };
      }
      return null;
    },
    // ── IAM groups ───────────────────────────────────────────────────
    (m, s) => {
      if (s[0] === 'accounts' && s[2] === 'iam' && s[3] === 'groups') {
        const tail = s.slice(4); // after /groups
        if (m === 'POST' && tail.length === 0)
          return { title: tI18nComplete.raw('texte0edaf920655'), kind: 'create' };
        if (m === 'PATCH' && tail.length === 1)
          return { title: tI18nComplete.raw('text1a5971d4dc9f'), kind: 'update' };
        if (m === 'DELETE' && tail.length === 1)
          return { title: tI18nComplete.raw('textfc718110809e'), kind: 'delete' };
        if (tail[1] === 'members') {
          if (m === 'POST') return { title: tI18nComplete.raw('text56b0e1edef9a'), kind: 'attach' };
          if (m === 'DELETE')
            return { title: tI18nComplete.raw('text5ba18b8f3b74'), kind: 'detach' };
        }
        if (tail[1] === 'project-grants')
          return { title: tI18nComplete.raw('textcb7a14a8cd1d'), kind: 'read' };
      }
      return null;
    },
    // ── Account settings (MFA, SSO, SCIM, session, PAT) ──────────────
    (m, s) => {
      if (s[0] === 'accounts' && s[2] === 'iam') {
        if (s[3] === 'mfa-required' && m === 'PATCH')
          return { title: tI18nComplete.raw('text23ffb018d2a2'), kind: 'update' };
        if (s[3] === 'session-policy' && m === 'PATCH')
          return { title: tI18nComplete.raw('textce582f2663e8'), kind: 'update' };
        if (s[3] === 'sessions' && s[5] === 'revoke')
          return { title: tI18nComplete.raw('textd4bc8ec6a562'), kind: 'revoke' };
        if (s[3] === 'pat-policy' && m === 'PATCH')
          return { title: tI18nComplete.raw('text80f505ac6a81'), kind: 'update' };
        if (s[3] === 'sso' && s[4] === 'provider') {
          if (m === 'PUT') return { title: tI18nComplete.raw('text2decf9534011'), kind: 'update' };
          if (m === 'DELETE')
            return { title: tI18nComplete.raw('text0268dc441c39'), kind: 'delete' };
        }
        if (s[3] === 'sso' && s[4] === 'mappings') {
          if (m === 'POST') return { title: tI18nComplete.raw('texteaf9eda43588'), kind: 'create' };
          if (m === 'DELETE')
            return { title: tI18nComplete.raw('textb5e0b14b924e'), kind: 'delete' };
        }
        if (s[3] === 'scim' && s[4] === 'tokens') {
          if (m === 'POST') return { title: tI18nComplete.raw('text7d5fcb164f17'), kind: 'create' };
          if (m === 'DELETE')
            return { title: tI18nComplete.raw('textaba314822529'), kind: 'revoke' };
        }
        if (s[3] === 'service-accounts') {
          if (m === 'POST' && s.length === 4)
            return { title: tI18nComplete.raw('text6a49860e54af'), kind: 'create' };
          if (s[5] === 'disable')
            return { title: tI18nComplete.raw('text8d4800aa530c'), kind: 'update' };
          if (m === 'DELETE' && s.length === 5)
            return { title: tI18nComplete.raw('text22489bebb98f'), kind: 'delete' };
        }
      }
      return null;
    },
    // ── Audit export ────────────────────────────────────────────────
    (m, s) => {
      if (s[0] === 'accounts' && s[2] === 'audit' && s[3] === 'export')
        return { title: tI18nComplete.raw('text3139ff90b6e9'), kind: 'export' };
      return null;
    },
  ];
}

// ─── Public API ───────────────────────────────────────────────────────────

function translateAuditTitle(title: string, tI18nComplete: UiTranslator): string {
  const key = AUDIT_TITLE_TRANSLATION_KEYS[title];
  return key ? tI18nComplete.raw(key as Parameters<UiTranslator['raw']>[0]) : title;
}

function describeNamedAction(
  action: string,
  tI18nComplete: UiTranslator,
): HumanizedAuditAction | null {
  const iam = IAM_ACTION_MAP[action];
  if (iam) return { title: translateAuditTitle(iam.title, tI18nComplete), kind: iam.kind };

  if (action === 'session.created') {
    return { title: tI18nComplete.raw('text1f2cde4f0d46'), kind: 'create' };
  }
  if (action === 'connector.approval.approved') {
    return { title: tI18nComplete.raw('textd2555357d10a'), kind: 'grant' };
  }
  if (action === 'connector.approval.denied') {
    return { title: tI18nComplete.raw('text82ff2bbaa7ac'), kind: 'revoke' };
  }
  if (action.startsWith('connector.')) {
    return {
      title: tI18nComplete.raw('text4571b6091ba2'),
      detail: action.slice('connector.'.length),
      kind: 'update',
    };
  }
  if (action.startsWith('computer.')) {
    return {
      title: tI18nComplete.raw('texta31f402d0382'),
      detail: action.slice('computer.'.length),
      kind: 'update',
    };
  }
  return null;
}

function matchHttpRoute(method: string, path: string): RouteMatcher | null {
  return (
    HTTP_ROUTE_MATCHERS.find(
      (candidate) => candidate.method === method && candidate.pattern.test(path),
    ) ?? null
  );
}

function routeArea(path: string): string {
  if (path.startsWith('/internal/gateway/')) return 'Gateway';
  if (path.startsWith('/scim/')) return 'SCIM';
  if (path === '/health' || path === '/health/live' || path === '/metrics') return 'System';
  if (path.includes('/accounts/:accountId/audit')) return 'Account audit';
  if (path.includes('/accounts/:accountId/iam')) return 'Identity and access';
  if (path.includes('/projects/:projectId/sessions') || path.includes('/turn-')) return 'Sessions';
  if (path.includes('/projects/:projectId/gateway')) return 'AI gateway';
  if (path.includes('/connector') || path.startsWith('/v1/connectors/')) return 'Connectors';
  if (path.startsWith('/v1/billing/')) return 'Billing';
  if (path.startsWith('/v1/tunnel/')) return 'Computer';
  if (path.startsWith('/v1/admin/')) return 'Administration';
  if (path.startsWith('/v1/marketplace/')) return 'Marketplace';
  if (path.startsWith('/v1/webhooks/')) return 'Webhooks';
  if (path.includes('/channels/')) return 'Channels';
  if (path.startsWith('/v1/router/') || path.startsWith('/v1/llm/')) return 'Models';
  if (path.startsWith('/v1/projects')) return 'Projects';
  if (path.startsWith('/v1/accounts') || path.startsWith('/v1/account')) return 'Accounts';
  return 'API';
}

function compactHttpAction(method: string, path: string): string {
  return `${method} ${path.replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '/…')}`;
}

/**
 * Describe an audit action with a readable title and its matched route.
 * Unknown actions keep the compact raw value as their title.
 */
export function describeAuditAction(
  action: string,
  tI18nComplete: UiTranslator,
): AuditActionDescription {
  // 1. The catalog: every route's own action, and every event a writer
  //    records outside a route.
  const label = auditLabelForAction(action);
  if (label) {
    const target = auditRouteForAction(label.action);
    const route = target && target.method !== 'ENTRY' ? target.route : null;
    const method = target && route && target.method !== 'ALL' ? target.method : null;
    const detail = auditFamilyDetail(action);
    return {
      title: translateAuditTitle(label.title, tI18nComplete),
      ...(detail ? { detail } : {}),
      // A family action (`connector.gmail.send_email`) is a call the verb
      // table cannot read; it has always shown as an update.
      kind: IAM_ACTION_MAP[label.action]?.kind ?? (detail ? 'update' : kindForAction(label.action, method)),
      mapped: true,
      method,
      route,
      area: route ? routeArea(route) : null,
    };
  }

  // 2. Named actions older rows carry and the catalog no longer lists.
  const named = describeNamedAction(action, tI18nComplete);
  if (named) {
    return { ...named, mapped: true, method: null, route: null, area: null };
  }

  // 3. Rows written before labels existed: the request line.
  const httpMatch = action.match(/^([A-Z]+)\s+(\/\S+)$/);
  if (httpMatch) {
    const method = httpMatch[1];
    const rawPath = httpMatch[2];
    const path = rawPath.split('?')[0].replace(/\/$/, '') || '/';
    const route = matchHttpRoute(method, path);
    const tail = path.replace(/^\/v1\/?/, '');
    const segments = tail ? tail.split('/').map((seg) => (isUuid(seg) ? ':id' : seg)) : [];
    let pattern: HumanizedAuditAction | null = null;
    for (const handler of httpPatterns(tI18nComplete)) {
      pattern = handler(method, segments, path);
      if (pattern) break;
    }
    const catalog = route ? auditLabelForRoute(method, route.path) : null;
    if (catalog && route) {
      return {
        title: translateAuditTitle(catalog.title, tI18nComplete),
        ...(pattern?.detail ? { detail: pattern.detail } : {}),
        kind: pattern?.kind ?? kindFromMethod(method),
        mapped: true,
        method,
        route: route.path,
        area: routeArea(route.path),
      };
    }
    if (pattern) {
      return { ...pattern, mapped: true, method, route: null, area: routeArea(path) };
    }
    return {
      title: compactHttpAction(method, path),
      kind: kindFromMethod(method),
      mapped: false,
      method,
      route: null,
      area: 'API',
    };
  }

  return {
    title: action,
    kind: 'other',
    mapped: false,
    method: null,
    route: null,
    area: null,
  };
}

/**
 * Return the compact shape used by existing audit consumers.
 */
export function humanizeAuditAction(
  action: string,
  tI18nComplete: UiTranslator,
): HumanizedAuditAction {
  const { title, detail, kind } = describeAuditAction(action, tI18nComplete);
  return detail ? { title, detail, kind } : { title, kind };
}

/** The kind a label action's verb names; its route's method otherwise. */
const VERB_KIND: Readonly<Record<string, HumanizedAuditAction['kind']>> = {
  list: 'read',
  read: 'read',
  check: 'read',
  preview: 'read',
  download: 'read',
  search: 'read',
  stream: 'read',
  create: 'create',
  created: 'create',
  connected: 'create',
  upload: 'create',
  invite: 'create',
  update: 'update',
  updated: 'update',
  changed: 'update',
  set: 'update',
  delete: 'delete',
  deleted: 'delete',
  remove: 'delete',
  cancel: 'delete',
  disconnect: 'delete',
  disconnected: 'delete',
  grant: 'grant',
  granted: 'grant',
  approve: 'grant',
  approved: 'grant',
  accept: 'grant',
  revoke: 'revoke',
  revoked: 'revoke',
  expired: 'revoke',
  deny: 'revoke',
  denied: 'revoke',
  decline: 'revoke',
  reject: 'revoke',
  add: 'attach',
  attach: 'attach',
  detach: 'detach',
  export: 'export',
};

function kindForAction(action: string, method: string | null): HumanizedAuditAction['kind'] {
  const verb = action.slice(action.lastIndexOf('.') + 1);
  return VERB_KIND[verb] ?? (method ? kindFromMethod(method) : 'other');
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

/**
 * Render a friendly resource pill: "Project · 8fb490fe" / "Group · Engineering".
 * Resource type comes from the audit_events row; the id is shortened
 * to the first 8 chars so it stays scannable.
 */
export function formatResourcePill(
  resourceType: string | null | undefined,
  resourceId: string | null | undefined,
): string | null {
  if (!resourceType) return null;
  const label = resourceType.replace(/_/g, ' ');
  const short = resourceId ? resourceId.slice(0, 8) : null;
  return short ? `${label} · ${short}` : label;
}

/**
 * Tailwind colour classes per action-kind. Used for the small leading
 * dot on each row. Kept in this module so the row component stays a
 * presentation shell.
 */
export const KIND_DOT_CLASS: Record<HumanizedAuditAction['kind'], string> = {
  create: 'bg-emerald-500/70',
  update: 'bg-amber-500/70',
  delete: 'bg-rose-500/70',
  grant: 'bg-violet-500/70',
  revoke: 'bg-rose-500/70',
  attach: 'bg-sky-500/70',
  detach: 'bg-zinc-400/70',
  read: 'bg-zinc-300/60',
  export: 'bg-sky-500/70',
  other: 'bg-zinc-300/60',
};
