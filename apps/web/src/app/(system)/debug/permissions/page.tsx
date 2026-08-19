'use client';

import { SessionPermissionPrompt } from '@/features/session/session-permission-prompt';
import type { PermissionRequest } from '@/ui/types';
import { useState } from 'react';

/**
 * /debug/permissions
 *
 * Visual harness for `SessionPermissionPrompt` outside a live session — lets
 * you stare at the chrome (short command, long/multiline command needing
 * expand, mixed permission types feeding the project-config footer) without
 * driving an agent through an actual `ask`-mode tool call.
 *
 * Mirrors the chat column width so spacing reads true. Not linked from
 * anywhere — just hit /debug/permissions.
 */

const SHORT: PermissionRequest = {
  id: 'perm_short',
  sessionID: 'ses_dbg',
  permission: 'bash',
  patterns: ['git status'],
  metadata: {},
  always: [],
};

const LONG: PermissionRequest = {
  id: 'perm_long',
  sessionID: 'ses_dbg',
  permission: 'bash',
  patterns: [
    "kortix sessions digest --since 24h --json 2>&1 echo 'KORTIX_EXIT:' $?; kortix cr ls --state merged --limit 20 2>&1 echo 'KORTIX_EXIT:' $?; git log -- .kortix/ -15 --oneline 2>&1",
  ],
  metadata: {},
  always: [],
};

const EDIT: PermissionRequest = {
  id: 'perm_edit',
  sessionID: 'ses_dbg',
  permission: 'edit',
  patterns: ['apps/web/src/features/session/session-chat.tsx'],
  metadata: {},
  always: [],
};

const WEBFETCH: PermissionRequest = {
  id: 'perm_webfetch',
  sessionID: 'ses_dbg',
  permission: 'webfetch',
  patterns: ['https://api.github.com/repos/kortix-ai/suna/commits'],
  metadata: {},
  always: [],
};

const SCENARIOS: Record<string, PermissionRequest[]> = {
  'Single short command': [SHORT],
  'Long / multiline command (expand-to-review)': [LONG],
  'Four mixed actions (matches the reported screenshot)': [SHORT, LONG, EDIT, WEBFETCH],
};

export default function DebugPermissionsPage() {
  const [scenario, setScenario] = useState<keyof typeof SCENARIOS>(
    'Four mixed actions (matches the reported screenshot)',
  );
  const [answered, setAnswered] = useState<Set<string>>(new Set());

  const permissions = SCENARIOS[scenario].filter((p) => !answered.has(p.id));

  return (
    <div className="bg-background min-h-screen px-6 py-10">
      <div className="mx-auto max-w-xl space-y-4">
        <div className="flex flex-wrap gap-2">
          {Object.keys(SCENARIOS).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setScenario(key);
                setAnswered(new Set());
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

        <SessionPermissionPrompt
          sessionId="ses_dbg"
          permissions={permissions}
          onReply={async (requestId) => {
            await new Promise((r) => setTimeout(r, 300));
            setAnswered((current) => new Set(current).add(requestId));
          }}
        />

        <div className="border-border bg-popover rounded-md border px-3 py-2">
          <span className="text-muted-foreground text-xs">Ask anything...</span>
        </div>
      </div>
    </div>
  );
}
