'use client';

import { Composer } from '@kortix/ui/composer';
import { ApprovalParameters, SessionApprovalNotice } from '@kortix/ui/session';
import { ApprovalDecisionPanel } from '@kortix/ui/markdown/setup-links/approval-decision';
import { approvalNoticeRows, type DecidedApproval } from '@kortix/ui/session/prompts/session-approval-review';
import { type ApprovalLinkDetails, SESSION_NOTICE, type SessionAuditAction } from '@kortix/sdk';
import { useState } from 'react';

/**
 * /debug/approvals
 *
 * Visual harness for the in-session connector approval, docked onto the REAL
 * composer the way a session mounts it: the notice goes in `inputSlot`, and
 * `questionActive` is on while a call is pending — the same docked surface a
 * question gets. Seeing it for real otherwise needs a live policy-gated
 * connector call.
 *
 * Deny / Approve here only record the decision locally; the decided call drops
 * out of the pending set and the next one takes its place, as in a session.
 * Not linked from anywhere; just hit /debug/approvals.
 */

const BASE: SessionAuditAction = {
  execution_id: 'exec-1',
  action: 'gmail.send_email',
  connector_id: 'conn-1',
  connector: 'gmail',
  status: 'pending_approval',
  risk: 'write',
  acted_by: 'user-1',
  acted_by_email: 'user@example.test',
  resolved_by: null,
  resolved_by_email: null,
  result_summary: {
    args_preview: { to: ['ops@example.test'], subject: 'Weekly report' },
    args_preview_complete: true,
  },
  at: new Date(Date.now() - 17 * 3_600_000).toISOString(),
  resolved_at: null,
  approval_url: 'https://dev.kortix.com/approve/tok-1',
};

const row = (id: string, patch: Partial<SessionAuditAction>): SessionAuditAction => ({
  ...BASE,
  execution_id: id,
  ...patch,
});

const SLACK_TEST = row('exec-slack-1', {
  action: 'kortix_slack.send_message',
  connector: 'kortix_slack',
  result_summary: {
    args_preview: { channel: '#triage', text: 'test' },
    args_preview_complete: true,
  },
});

const SLACK_LONG = row('exec-slack-2', {
  action: 'kortix_slack.send_message',
  connector: 'kortix_slack',
  result_summary: {
    args_preview: {
      channel: '#triage',
      text: 'Fixed — warm "New session" row gone from the sidebar after a reload. Root cause was a stale cache entry kept alive by the optimistic insert; the list now reconciles on the first server page.',
    },
    args_preview_complete: true,
  },
});

const SEND_DRAFT = row('exec-draft', {
  action: 'gmail.send_draft',
  result_summary: {
    args_preview: { draft_id: 'r-draft-1' },
    args_preview_complete: true,
    approval_context: 'Sends the weekly report draft to ops.',
  },
});

/** The draft the server loads for `SEND_DRAFT` (Task 2 fills it for real). */
const RESOLVED_DRAFT = {
  to: ['ops@example.test'],
  cc: ['lead@example.test'],
  subject: 'Weekly report',
  body: 'Hi team,\n\nThis week: two releases, one incident, zero open blockers.\n\nThanks',
};

const SCENARIOS: Record<string, SessionAuditAction[]> = {
  'Two pending (the screenshot)': [SLACK_TEST, SLACK_LONG],
  'One pending': [BASE],
  'Three pending, mixed risk': [
    BASE,
    row('exec-2', { action: 'github.repos.delete', risk: 'destructive' }),
    row('exec-3', {
      action: 'slack.ping',
      risk: 'read',
      result_summary: { args_preview: { channel: '#ops' }, args_preview_complete: true },
    }),
  ],
  'Agent context + shortened value': [
    row('exec-trunc', {
      result_summary: {
        args_preview: {
          to: ['ops@example.test'],
          subject: 'Signed contract',
          body: 'Attached, please counter-sign.',
          attachment: '[204800 chars omitted]',
        },
        args_preview_complete: false,
        approval_context: 'The user asked me to send the signed contract to ops once it was ready.',
      },
    }),
  ],
  'Send draft (id only)': [SEND_DRAFT],
  'Nothing recorded (deny only)': [
    row('exec-blind', {
      action: 'github.repos.delete',
      risk: 'destructive',
      result_summary: { args_preview_complete: false },
    }),
  ],
};

/** The decision panel (Review Center modal, `/approve/[token]`) for the three V01 connectors. */
function decisionCall(
  action: string,
  connectorName: string,
  risk: string,
  args: Record<string, unknown>,
  context: string,
  minutesLeft: number,
): ApprovalLinkDetails {
  return {
    kind: 'approval',
    project_id: 'project-debug',
    project_name: 'Debug',
    execution_id: action,
    session_id: 'ses_debug',
    action,
    connector: action.split('.')[0],
    connector_name: connectorName,
    risk,
    status: 'pending_approval',
    pending: true,
    args_preview: args,
    review_complete: true,
    args_summary: null,
    approval_context: context,
    policy_source: null,
    requested_at: new Date().toISOString(),
    resolved_at: null,
    expires_at: new Date(Date.now() + minutesLeft * 60_000).toISOString(),
  };
}

const DECISION_CALLS = [
  decisionCall(
    'gmail.send_email',
    'Gmail',
    'write',
    {
      from: 'ops@example.test',
      to: 'reviewer@example.test',
      cc: 'finance@example.test',
      subject: 'Q3 launch notes',
      body: 'Hi, attached are the Q3 launch notes.\nThe rollout starts Monday with the web app.\nFlag anything before Friday’s sync.',
      attachments: [{ name: 'q3-launch-notes.pdf', size: 245_760 }],
    },
    'Send the Q3 launch notes to the reviewer before Friday’s sync.',
    134,
  ),
  decisionCall(
    'github.merge_pull_request',
    'GitHub',
    'destructive',
    { owner: 'example-org', repo: 'web', pull_number: 482, merge_method: 'squash' },
    'Merge the stale-cache fix so QA can test the launch build.',
    38,
  ),
  decisionCall(
    'linear.create_issue',
    'Linear',
    'write',
    {
      team: 'Platform',
      title: 'Session list skips archived projects',
      description: 'Archived projects disappear from the session list after a refresh.\nExpected: they show under an Archived group.',
      priority: 2,
      assignee: 'Sam Lee',
      labels: ['Bug', 'Web'],
    },
    'Track the archived-projects bug found during launch QA.',
    23 * 60 + 10,
  ),
];

const NOTICES = { none: null, waking: SESSION_NOTICE.waking } as const;

export default function DebugApprovalsPage() {
  const [scenario, setScenario] = useState<string>('Two pending (the screenshot)');
  const [notice, setNotice] = useState<keyof typeof NOTICES>('waking');
  const [current, setCurrent] = useState<string | null>(null);
  const [decided, setDecided] = useState<Record<string, DecidedApproval>>({});

  const actions = SCENARIOS[scenario].filter((a) => !decided[a.execution_id]);
  const rows = approvalNoticeRows(actions, decided);
  const docked = rows.some((r) => r.decision === null);

  const pill = (active: boolean) =>
    `cursor-pointer rounded-md border px-2.5 py-1 text-xs ${
      active
        ? 'border-foreground bg-foreground text-background'
        : 'border-border text-muted-foreground hover:text-foreground'
    }`;

  return (
    <div className="bg-background flex min-h-screen flex-col">
      <div className="mx-auto flex w-full max-w-210 flex-col gap-3 px-4 pt-10">
        <div className="flex flex-wrap gap-2">
          {Object.keys(SCENARIOS).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setScenario(key);
                setCurrent(null);
                setDecided({});
              }}
              className={pill(scenario === key)}
            >
              {key}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs">Notice under the card</span>
          {(Object.keys(NOTICES) as (keyof typeof NOTICES)[]).map((key) => (
            <button key={key} type="button" onClick={() => setNotice(key)} className={pill(notice === key)}>
              {key}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setCurrent(null);
              setDecided({});
            }}
            className={pill(false)}
          >
            Reset decisions
          </button>
        </div>
      </div>

      {/* The parameters renderer on its own: an id-only call, and the same call
          with the draft the server loaded for the reviewer. */}
      <div className="mx-auto grid w-full max-w-210 gap-3 px-4 pt-6 sm:grid-cols-2">
        <ApprovalParameters
          argsPreview={{ draft_id: 'r-draft-1' }}
          className="overflow-hidden rounded-md border"
        />
        <ApprovalParameters
          action="gmail.send_draft"
          argsPreview={{ draft_id: 'r-draft-1' }}
          resolvedPreview={RESOLVED_DRAFT}
          resolvedFrom="Gmail"
          className="overflow-hidden rounded-md border"
        />
      </div>

      {/* The decision panel as the Review Center modal renders it. */}
      <div className="mx-auto grid w-full max-w-7xl items-start gap-6 px-4 pt-6 lg:grid-cols-3">
        {DECISION_CALLS.map((details) => (
          <div
            key={details.execution_id}
            data-testid={`decision-${details.connector}`}
            className="bg-popover border-border overflow-hidden rounded-xl border shadow-md"
          >
            <ApprovalDecisionPanel
              details={details}
              outcome={null}
              busyDecision={null}
              error={null}
              onDecision={() => undefined}
              onOpenSession={() => undefined}
              agentName="Writer"
              sessionTitle="Q3 launch prep"
            />
          </div>
        ))}
      </div>

      {/* Transcript stand-in, so the docked card reads against real height. */}
      <div className="flex-1" />

      <div className="pb-6">
        <Composer
          onSend={() => {}}
          sessionId="ses_debug"
          notice={NOTICES[notice]}
          questionActive={docked}
          inputSlot={
            <SessionApprovalNotice
              rows={rows}
              current={current}
              busy={{}}
              onSelect={setCurrent}
              onDecide={(id, decision) => {
                const action = SCENARIOS[scenario].find((a) => a.execution_id === id);
                if (action) setDecided((d) => ({ ...d, [id]: { action, decision } }));
              }}
            />
          }
        />
      </div>
    </div>
  );
}
