'use client';

import { Composer } from '@/features/session/composer/composer';
import { SessionApprovalNotice } from '@/features/session/session-approval-prompt';
import { approvalNoticeRows, type DecidedApproval } from '@/features/session/session-approval-review';
import { SESSION_NOTICE, type SessionAuditAction } from '@kortix/sdk';
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
  'Nothing recorded (deny only)': [
    row('exec-blind', {
      action: 'github.repos.delete',
      risk: 'destructive',
      result_summary: { args_preview_complete: false },
    }),
  ],
};

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
