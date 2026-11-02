'use client';

/**
 * Tools' footer on the agent page: one card that says what the agent's
 * approval rules do ("2 tools ask before they run. rm -rf * is denied."),
 * and Edit rules, which unfolds the rules editor under it.
 */

import type { PermissionConfig } from '@kortix/sdk';
import { capabilityGranted } from '@kortix/sdk';
import { ShieldIcon } from '@phosphor-icons/react';
import { type ReactNode, useState } from 'react';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { useProjectCapabilities } from '../../internal/hooks/projects/use-agent-config';
import { Button } from '../../primitives/button';
import type { AgentDraft } from '../sections/view/agent-editor';
import { deniedPatterns, toolRule } from '../shared/tool-rules';

export function AgentApprovalRules({
  projectId,
  editor,
  rules,
}: {
  projectId: string;
  editor: AgentDraft;
  /** The rules editor Edit rules unfolds. */
  rules: ReactNode;
}) {
  const t = useI18nTranslations('agentEditor.tabs');
  const [open, setOpen] = useState(false);
  const tools = useProjectCapabilities(projectId).data?.tools ?? [];
  const permission: PermissionConfig | undefined = editor.oc.permission;
  const asking = tools.filter(
    (tool) => capabilityGranted(editor.draft.tools, tool.id, 'all') && toolRule(permission, tool.id) === 'ask',
  ).length;
  const denied = deniedPatterns(permission);
  const sentence =
    asking === 0 && denied.length === 0
      ? t('approvalNone')
      : [
          asking > 0 ? t('approvalAsk', { count: asking }) : null,
          denied.length > 0 ? t('approvalDenied', { list: denied.join(', ') }) : null,
        ]
          .filter(Boolean)
          .join(' ');
  return (
    <div className="space-y-5">
      <div className="bg-popover flex items-center gap-3 rounded-lg px-4 py-3">
        <ShieldIcon className="text-muted-foreground size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-sm font-medium">{t('approvalTitle')}</p>
          <p className="text-muted-foreground text-xs text-pretty">{sentence}</p>
        </div>
        <Button variant="secondary" size="sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? t('hideRules') : t('editRules')}
        </Button>
      </div>
      {open ? rules : null}
    </div>
  );
}
