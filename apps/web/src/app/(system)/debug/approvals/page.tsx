'use client';

import {
  COMPOSER_INPUT_SLOT_CLASS,
  COMPOSER_SHELL_CLASS,
} from '@/features/session/composer/composer';
import { SessionApprovalNotice } from '@/features/session/session-approval-prompt';
import { approvalNoticeRows } from '@/features/session/session-approval-review';
import type { SessionAuditAction } from '@kortix/sdk';
import { useState } from 'react';

/**
 * /debug/approvals
 *
 * Visual harness for the in-session connector approval card. Seeing it for
 * real otherwise needs a live policy-gated connector call, which is why two
 * defects sat in it unnoticed:
 *
 *  1. The card had no `w-full`, so the composer's `items-center` strip sized
 *     it to its CONTENT — the width tracked whatever tool name was pending.
 *  2. Any elided value (a long URL, an 11th recipient, an attachment body)
 *     disabled Approve and printed a warning, leaving Deny as the only answer.
 *
 * The strip below is the REAL one — `COMPOSER_INPUT_SLOT_CLASS` and
 * `COMPOSER_SHELL_CLASS` are imported from the composer, not copied — so a
 * width measured here is the width the session renders. Not linked from
 * anywhere; just hit /debug/approvals.
 */

const BASE: SessionAuditAction = {
  execution_id: 'exec-1',
  action: 'gmail.send_email',
  connector_id: 'conn-1',
  connector: 'gmail',
  status: 'pending_approval',
  risk: 'write',
  acted_by: 'user-1',
  acted_by_email: 'marko@kortix.ai',
  resolved_by: null,
  resolved_by_email: null,
  result_summary: {
    args_preview: { to: ['marko@kortix.ai'], subject: 'Weekly report' },
    args_preview_complete: true,
  },
  at: new Date().toISOString(),
  resolved_at: null,
  approval_url: 'https://dev.kortix.com/approve/tok-1',
};

const row = (id: string, patch: Partial<SessionAuditAction>): SessionAuditAction => ({
  ...BASE,
  execution_id: id,
  ...patch,
});

const SCENARIOS: Record<string, SessionAuditAction[]> = {
  'Complete preview (approvable)': [BASE],
  // The regression case: `args_preview_complete` is false, but every elision
  // is written into the preview, so the call is still decidable.
  'Shortened value — attachment (approvable)': [
    row('exec-trunc', {
      action: 'gmail.send_email',
      result_summary: {
        args_preview: {
          to: ['ops@kortix.ai'],
          subject: 'Signed contract',
          body: 'Attached, please counter-sign.',
          attachment: '[204800 chars omitted]',
        },
        args_preview_complete: false,
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
  'Short tool name (the width regression)': [
    row('exec-short', {
      action: 'slack.ping',
      risk: 'read',
      result_summary: { args_preview: { channel: '#ops' }, args_preview_complete: true },
    }),
  ],
  'Three pending at once': [
    BASE,
    row('exec-2', { action: 'github.repos.delete', risk: 'destructive' }),
    row('exec-3', { action: 'slack.ping', risk: 'read' }),
  ],
};

export default function DebugApprovalsPage() {
  const [scenario, setScenario] = useState<keyof typeof SCENARIOS>(
    'Shortened value — attachment (approvable)',
  );
  const [expanded, setExpanded] = useState<string | null>('exec-trunc');
  const [decided, setDecided] = useState<Record<string, 'approve' | 'deny'>>({});

  const actions = SCENARIOS[scenario];
  const rows = approvalNoticeRows(actions, {}).map((r) => ({
    ...r,
    decision: decided[r.action.execution_id] ?? null,
  }));

  return (
    <div className="bg-background min-h-screen py-10">
      <div className="mx-auto mb-6 flex max-w-210 flex-wrap gap-2 px-4">
        {Object.keys(SCENARIOS).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setScenario(key);
              setExpanded(SCENARIOS[key][0]?.execution_id ?? null);
              setDecided({});
            }}
            className={`rounded-md border px-2.5 py-1 text-xs ${
              scenario === key
                ? 'border-foreground bg-foreground text-background'
                : 'border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            {key}
          </button>
        ))}
      </div>

      {/* The composer's own shell + inset strip, imported not copied. */}
      <div className={COMPOSER_SHELL_CLASS}>
        <div className="relative isolate flex w-full flex-col items-center justify-center">
          <div data-testid="composer-input-slot" className={COMPOSER_INPUT_SLOT_CLASS}>
            <SessionApprovalNotice
              rows={rows}
              expanded={expanded}
              busy={{}}
              onToggle={(id) => setExpanded((current) => (current === id ? null : id))}
              onDecide={(id, decision) => setDecided((current) => ({ ...current, [id]: decision }))}
            />
          </div>
        </div>
        <div className="bg-popover border-border rounded-b-xl border px-3 py-4">
          <span className="text-muted-foreground text-sm">Ask anything…</span>
        </div>
      </div>
    </div>
  );
}
