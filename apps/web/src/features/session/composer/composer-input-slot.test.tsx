/**
 * The composer's inset strip centres its children, so every notice mounted
 * into it must declare its own width.
 *
 * This is a real bug that shipped: the approval and permission notices had no
 * `w-full`, so `items-center` sized them to their CONTENT — the card was as
 * wide as whatever tool name happened to be pending, which is why it looked
 * broken only sometimes. `QuestionPrompt` and the reply bar already carried
 * `w-full`; nothing enforced it, so the next notice added forgot again.
 *
 * Renders the REAL component and reads its root class, so the guard cannot
 * drift from what the session actually mounts. `SessionPermissionPrompt` needs
 * an `AuthProvider` to render, so its width is measured in the browser harness
 * at /debug/approvals instead.
 */
import type { SessionAuditAction } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SessionApprovalNotice } from '@/features/session/session-approval-prompt';
import { approvalNoticeRows } from '@/features/session/session-approval-review';
import { COMPOSER_INPUT_SLOT_CLASS } from './composer';

const pending: SessionAuditAction = {
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
  result_summary: { args_preview: { to: 'a@b.c' }, args_preview_complete: true },
  at: new Date().toISOString(),
  resolved_at: null,
  approval_url: null,
};

/** The class list of the outermost element a component renders. */
function rootClass(html: string): string {
  return /class="([^"]*)"/.exec(html.slice(0, html.indexOf('>') + 1))?.[1] ?? '';
}

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);

describe('COMPOSER_INPUT_SLOT_CLASS', () => {
  test('centres its children — which is why width is each notice’s job', () => {
    expect(COMPOSER_INPUT_SLOT_CLASS).toContain('flex-col');
    expect(COMPOSER_INPUT_SLOT_CLASS).toContain('items-center');
  });

  test('the approval notice sets its own width', () => {
    const html = render(
      <SessionApprovalNotice
        rows={approvalNoticeRows([pending], {})}
        expanded={null}
        busy={{}}
        onToggle={() => undefined}
        onDecide={() => undefined}
      />,
    );

    expect(rootClass(html).split(/\s+/)).toContain('w-full');
  });
});
