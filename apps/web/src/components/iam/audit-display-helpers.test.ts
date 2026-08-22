import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  AUDIT_HTTP_ROUTES,
  describeAuditAction,
  formatResourcePill,
  humanizeAuditAction,
} from './audit-display-helpers';

const UID = '8fb490fe-4765-480e-9e83-08b4b41a3f06';
const UID2 = '47dd83e0-c532-4643-a0c1-112abab26d5e';

interface RouteManifest {
  routes: Array<{ method: string; path: string }>;
}

const routeManifest = JSON.parse(
  readFileSync(new URL('../../../../../tests/spec/routes.generated.json', import.meta.url), 'utf8'),
) as RouteManifest;

function materializeRoute(path: string): string {
  return path
    .split('/')
    .map((segment) => (segment.startsWith(':') ? `sample-${segment.slice(1)}` : segment))
    .join('/');
}

describe('audit HTTP route registry', () => {
  test('contains every route in the authoritative API manifest', () => {
    const expected = routeManifest.routes.map(({ method, path }) => `${method} ${path}`).sort();
    expect([...AUDIT_HTTP_ROUTES].sort()).toEqual(expected);
  });

  test('maps every API route to a readable label', () => {
    for (const route of routeManifest.routes) {
      const display = describeAuditAction(`${route.method} ${materializeRoute(route.path)}`);
      expect(display.mapped, `${route.method} ${route.path}`).toBe(true);
      expect(display.route, `${route.method} ${route.path}`).toBe(route.path);
      expect(display.title, `${route.method} ${route.path}`).not.toMatch(
        /^(GET|POST|PUT|PATCH|DELETE|OPTIONS) \/?/,
      );
    }
  });

  test('uses specific labels for common audit routes', () => {
    expect(describeAuditAction(`GET /v1/accounts/${UID}/audit/webhooks`).title).toBe(
      'Listed audit webhooks',
    );
    expect(describeAuditAction(`POST /v1/accounts/${UID}/audit/webhooks`).title).toBe(
      'Created audit webhook',
    );
    expect(describeAuditAction(`POST /v1/accounts/${UID}/audit/reconcile`).title).toBe(
      'Reconciled audit log',
    );
    expect(
      describeAuditAction(`GET /v1/accounts/${UID}/audit/webhooks/${UID2}/deliveries`).title,
    ).toBe('Listed audit webhook deliveries');
    expect(
      describeAuditAction(
        `POST /v1/accounts/${UID}/audit/webhooks/${UID2}/deliveries/${UID}/replay`,
      ).title,
    ).toBe('Replayed audit webhook delivery');
    expect(describeAuditAction(`PATCH /v1/accounts/${UID}/audit/webhooks/${UID2}`).title).toBe(
      'Updated audit webhook',
    );
    expect(describeAuditAction(`GET /v1/projects/${UID}/audit`).title).toBe(
      'Viewed project audit log',
    );
    expect(describeAuditAction(`GET /v1/projects/${UID}/sessions/${UID2}/audit`).title).toBe(
      'Viewed session audit log',
    );
    expect(
      describeAuditAction(`POST /v1/projects/${UID}/sessions/${UID2}/audit/events`).title,
    ).toBe('Ingested session audit events');
    expect(
      describeAuditAction(`POST /v1/projects/${UID}/sessions/${UID2}/reload-stream`).title,
    ).toBe('Reloaded session agent config');
    expect(describeAuditAction(`POST /v1/projects/${UID}/turn-stream`).title).toBe(
      'Streamed session turn',
    );
    expect(
      describeAuditAction(`PUT /v1/projects/${UID}/secrets/ANTHROPIC_API_KEY/strategy`).title,
    ).toBe('Updated secret delivery strategy');
    expect(
      describeAuditAction(`PUT /v1/connectors/projects/${UID}/connectors/github/secret-binding`)
        .title,
    ).toBe('Updated connector secret binding');
  });

  test('preserves the compact raw route fallback for an unknown route', () => {
    expect(describeAuditAction(`POST /v1/widgets/${UID}/refresh`)).toMatchObject({
      title: 'POST /v1/widgets/…/refresh',
      mapped: false,
      method: 'POST',
      route: null,
    });
  });
});

describe('humanizeAuditAction — IAM action codes', () => {
  test('maps every named action emitted by the audit writers', () => {
    const actions = [
      'admin.account.session_limit.set',
      'admin.account.tier.set',
      'auth.login.fail',
      'auth.login.success',
      'auth.logout',
      'auth.session.first_sight',
      'enterprise_demo.disable',
      'enterprise_demo.enable',
      'iam.audit.webhook.create',
      'iam.audit.webhook.delete',
      'iam.audit.webhook.update',
      'iam.group.create',
      'iam.group.delete',
      'iam.group.members.add',
      'iam.group.members.remove',
      'iam.group.update',
      'iam.pat_policy.update',
      'iam.policy.bulk_import',
      'iam.policy.create',
      'iam.policy.delete',
      'iam.policy.update',
      'iam.project.group.expired',
      'iam.project.member.expired',
      'iam.role.create',
      'iam.role.delete',
      'iam.role.permissions.set',
      'iam.scim.token.create',
      'iam.scim.token.revoke',
      'iam.service_account.create',
      'iam.service_account.delete',
      'iam.service_account.disable',
      'iam.session.revoke',
      'iam.session_policy.update',
      'iam.sso.mapping.create',
      'iam.sso.mapping.delete',
      'iam.sso.provider.create',
      'iam.sso.provider.delete',
      'project.admin_bypass_read',
      'project.admin_bypass_session_read',
      'project.connector.read',
      'scim.group.create',
      'scim.group.delete',
      'scim.group.update',
      'scim.user.deactivate',
      'scim.user.delete',
      'scim.user.invite',
      'scim.user.invite_revoke',
      'session.created',
      'webhook.test',
    ];

    for (const action of actions) {
      const description = describeAuditAction(action);
      expect(description.mapped, action).toBe(true);
      expect(description.title, action).not.toBe(action);
    }
  });

  test('iam.group.create → Created group', () => {
    expect(humanizeAuditAction('iam.group.create')).toEqual({
      title: 'Created group',
      kind: 'create',
    });
  });
  test('iam.member.super_admin.grant → Granted super-admin', () => {
    expect(humanizeAuditAction('iam.member.super_admin.grant').title).toBe('Granted super-admin');
  });
  test('iam.project.group.detach → Detached…', () => {
    const r = humanizeAuditAction('iam.project.group.detach');
    expect(r.title).toBe('Detached group from project');
    expect(r.kind).toBe('detach');
  });
});

describe('humanizeAuditAction — HTTP routes', () => {
  test('POST /v1/projects/:id/group-grants → Attached group', () => {
    expect(humanizeAuditAction(`POST /v1/projects/${UID}/group-grants`)).toEqual({
      title: 'Attached group to project',
      kind: 'attach',
    });
  });

  test('PATCH /v1/projects/:id/group-grants/:gid → Changed role', () => {
    expect(humanizeAuditAction(`PATCH /v1/projects/${UID}/group-grants/${UID2}`)).toEqual({
      title: 'Changed group role on project',
      kind: 'update',
    });
  });

  test('DELETE /v1/projects/:id/group-grants/:gid → Detached', () => {
    expect(humanizeAuditAction(`DELETE /v1/projects/${UID}/group-grants/${UID2}`)).toEqual({
      title: 'Detached group from project',
      kind: 'detach',
    });
  });

  test('PUT shared secret carries the name as detail', () => {
    expect(humanizeAuditAction(`PUT /v1/projects/${UID}/secrets/MY_KEY`)).toEqual({
      title: 'Set shared secret',
      detail: 'MY_KEY',
      kind: 'update',
    });
  });

  test('PUT personal secret distinguishes from shared', () => {
    const r = humanizeAuditAction(`PUT /v1/projects/${UID}/secrets/TEST/personal`);
    expect(r.title).toBe('Set personal secret');
    expect(r.detail).toBe('TEST');
    expect(r.kind).toBe('update');
  });

  test('DELETE personal secret', () => {
    expect(humanizeAuditAction(`DELETE /v1/projects/${UID}/secrets/X/personal`)).toEqual({
      title: 'Removed personal secret',
      detail: 'X',
      kind: 'delete',
    });
  });

  test('POST /v1/projects/:id/access/invite → Invited project member', () => {
    expect(humanizeAuditAction(`POST /v1/projects/${UID}/access/invite`).title).toBe(
      'Invited project member',
    );
  });

  test('PATCH /v1/accounts/:id/members/:uid → Changed member role', () => {
    expect(humanizeAuditAction(`PATCH /v1/accounts/${UID}/members/${UID2}`).title).toBe(
      'Changed member role',
    );
  });

  test('PATCH /v1/accounts/:id/iam/members/:uid/super-admin → Set super-admin status', () => {
    expect(
      humanizeAuditAction(`PATCH /v1/accounts/${UID}/iam/members/${UID2}/super-admin`).title,
    ).toBe('Set super-admin status');
  });

  test('POST /v1/accounts/:id/iam/groups → Created group', () => {
    expect(humanizeAuditAction(`POST /v1/accounts/${UID}/iam/groups`).title).toBe('Created group');
  });

  test('DELETE /v1/accounts/:id/iam/groups/:gid/members/:uid → Removed member from group', () => {
    expect(
      humanizeAuditAction(`DELETE /v1/accounts/${UID}/iam/groups/${UID2}/members/${UID}`).title,
    ).toBe('Removed member from group');
  });

  test('PATCH /v1/accounts/:id/iam/mfa-required → Changed MFA requirement', () => {
    expect(humanizeAuditAction(`PATCH /v1/accounts/${UID}/iam/mfa-required`).title).toBe(
      'Changed MFA requirement',
    );
  });

  test('PATCH /v1/accounts/:id/iam/session-policy → Updated session policy', () => {
    expect(humanizeAuditAction(`PATCH /v1/accounts/${UID}/iam/session-policy`).title).toBe(
      'Updated session policy',
    );
  });

  // ── Patterns added for the screenshots in the audit-log polish pass ──

  test('PATCH /v1/accounts/:id → Updated account settings', () => {
    expect(humanizeAuditAction(`PATCH /v1/accounts/${UID}`).title).toBe('Updated account settings');
  });

  test('DELETE /v1/accounts/:id → Deleted account', () => {
    expect(humanizeAuditAction(`DELETE /v1/accounts/${UID}`)).toEqual({
      title: 'Deleted account',
      kind: 'delete',
    });
  });

  test('POST /v1/accounts/:id/iam/policy-templates/:slug/apply → Applied template + slug detail', () => {
    const r = humanizeAuditAction(
      `POST /v1/accounts/${UID}/iam/policy-templates/project-readonly-auditor/apply`,
    );
    expect(r.title).toBe('Applied policy template');
    expect(r.detail).toBe('project-readonly-auditor');
    expect(r.kind).toBe('grant');
  });

  test('iam.policy_template.apply → Applied policy template', () => {
    expect(humanizeAuditAction('iam.policy_template.apply')).toEqual({
      title: 'Applied policy template',
      kind: 'grant',
    });
  });

  test('DELETE /v1/projects/:id/access/pending-invites/:inviteId → Revoked pending invitation', () => {
    const r = humanizeAuditAction(`DELETE /v1/projects/${UID}/access/pending-invites/${UID2}`);
    expect(r.title).toBe('Revoked pending project invitation');
    expect(r.kind).toBe('revoke');
  });

  test('GET /v1/projects/:id/access/pending-invites → Listed pending invites', () => {
    expect(humanizeAuditAction(`GET /v1/projects/${UID}/access/pending-invites`).title).toBe(
      'Listed pending project invites',
    );
  });

  test('POST /v1/projects/:id/sessions → Started session', () => {
    expect(humanizeAuditAction(`POST /v1/projects/${UID}/sessions`)).toEqual({
      title: 'Started session',
      kind: 'create',
    });
  });

  test('POST /v1/projects/:id/sessions/:sid/exec → Ran session command', () => {
    expect(humanizeAuditAction(`POST /v1/projects/${UID}/sessions/${UID2}/exec`).title).toBe(
      'Ran session command',
    );
  });

  test('POST /v1/projects/:id/sessions/:sid/stop → Stopped session', () => {
    expect(humanizeAuditAction(`POST /v1/projects/${UID}/sessions/${UID2}/stop`).title).toBe(
      'Stopped session',
    );
  });

  test('POST /v1/projects/:id/triggers/:tid/fire → Fired trigger', () => {
    expect(humanizeAuditAction(`POST /v1/projects/${UID}/triggers/${UID2}/fire`).title).toBe(
      'Fired trigger',
    );
  });

  test('POST /v1/projects/:id/secrets (root, no name) → Set project secret', () => {
    expect(humanizeAuditAction(`POST /v1/projects/${UID}/secrets`)).toEqual({
      title: 'Set project secret',
      kind: 'update',
    });
  });

  test('POST /v1/accounts/:id/iam/policies → Created IAM policy', () => {
    expect(humanizeAuditAction(`POST /v1/accounts/${UID}/iam/policies`)).toEqual({
      title: 'Created IAM policy',
      kind: 'create',
    });
  });

  test('DELETE /v1/accounts/:id/iam/policies/:pid → Deleted IAM policy', () => {
    expect(humanizeAuditAction(`DELETE /v1/accounts/${UID}/iam/policies/${UID2}`).title).toBe(
      'Deleted IAM policy',
    );
  });

  test('iam.policy.create → Created IAM policy (legacy code)', () => {
    expect(humanizeAuditAction('iam.policy.create')).toEqual({
      title: 'Created IAM policy',
      kind: 'create',
    });
  });

  test('iam.policy.delete → Deleted IAM policy', () => {
    expect(humanizeAuditAction('iam.policy.delete').title).toBe('Deleted IAM policy');
  });
});

describe('humanizeAuditAction — fallbacks', () => {
  test('central session and agent actions use concise labels', () => {
    expect(humanizeAuditAction('session.created')).toEqual({
      title: 'Started session',
      kind: 'create',
    });
    expect(humanizeAuditAction('connector.gmail.send_email')).toEqual({
      title: 'Ran connector call',
      detail: 'gmail.send_email',
      kind: 'update',
    });
    expect(humanizeAuditAction('connector.approval.denied')).toEqual({
      title: 'Denied connector action',
      kind: 'revoke',
    });
    expect(humanizeAuditAction('computer.shell.exec')).toEqual({
      title: 'Ran computer operation',
      detail: 'shell.exec',
      kind: 'update',
    });
    expect(humanizeAuditAction('connector.computer.shell.exec')).toEqual({
      title: 'Ran connector call',
      detail: 'computer.shell.exec',
      kind: 'update',
    });
  });

  test('unknown HTTP route collapses long UUIDs to "/…"', () => {
    const r = humanizeAuditAction(`POST /v1/widgets/${UID}/refresh`);
    expect(r.title).toBe('POST /v1/widgets/…/refresh');
    expect(r.kind).toBe('create');
  });

  test('unknown HTTP method gets method-derived kind', () => {
    expect(humanizeAuditAction(`DELETE /v1/foo/${UID}`).kind).toBe('delete');
    expect(humanizeAuditAction(`PATCH /v1/foo/${UID}`).kind).toBe('update');
  });

  test('non-HTTP, non-IAM action falls back to the raw string', () => {
    expect(humanizeAuditAction('garbage')).toEqual({
      title: 'garbage',
      kind: 'other',
    });
  });
});

describe('formatResourcePill', () => {
  test('type + id → "type · short"', () => {
    expect(formatResourcePill('project', UID)).toBe('project · 8fb490fe');
  });
  test('type only → "type"', () => {
    expect(formatResourcePill('account_group', null)).toBe('account group');
  });
  test('null type → null', () => {
    expect(formatResourcePill(null, UID)).toBeNull();
  });
  test('underscore in type rendered as space', () => {
    expect(formatResourcePill('service_account', null)).toBe('service account');
  });
});
