import type { Icon as IconType, Icon as LucideIcon } from '@phosphor-icons/react';
import type { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

export type PageId =
  | 'home'
  | 'workspaces'
  | 'chat'
  | 'agents'
  | 'skills'
  | 'connectors'
  | 'models'
  | 'scheduling'
  | 'channels'
  | 'security';

export type Nav = (id: PageId) => void;

/* ─── CLI-driven demo state ──────────────────────────────────────────────── */

/** Lifecycle a workspace card moves through as the CLI drives it:
 *  `kortix init` creates a `draft`, `kortix ship` flips it `shipping` → `live`. */
export type WorkspaceStatus = 'draft' | 'shipping' | 'live';

export type WorkspaceCard = {
  name: string;
  status: WorkspaceStatus;
  files?: number;
  branch?: string;
  repo?: string;
  url?: string;
};

/** The active model/provider the CLI routes to (favicon `domain` + display `name`). */
export type ActiveModel = {
  domain: string;
  name: string;
};

export type DemoStep =
  | {
      id: string;
      kind: 'tool';
      tool: string;
      icon: LucideIcon | IconType;
      title: string;
      body?: ReactNode;
      durationMs: number;
    }
  | { id: string; kind: 'text'; markdown: string }
  | {
      id: string;
      kind: 'result';
      render: (tHardcodedUi: ReturnType<typeof useTranslations>) => ReactNode;
    };

export type DemoScenario = {
  id: string;
  prompt: string;
  sessionName: string;
  thinkingLabel: string;
  /** Skill names from the Skills catalog invoked during this scenario. */
  skills?: string[];
  steps: DemoStep[];
};
