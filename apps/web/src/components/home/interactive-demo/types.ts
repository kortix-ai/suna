import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { IconType } from 'react-icons/lib';

export type PageId =
  | 'home'
  | 'projects'
  | 'chat'
  | 'agents'
  | 'skills'
  | 'integrations'
  | 'models'
  | 'scheduling'
  | 'channels'
  | 'security';

export type Nav = (id: PageId) => void;

/* ─── CLI-driven demo state ──────────────────────────────────────────────── */

/** Lifecycle a project card moves through as the CLI drives it:
 *  `kortix init` creates a `draft`, `kortix ship` flips it `shipping` → `live`. */
export type ProjectStatus = 'draft' | 'shipping' | 'live';

export type ProjectCard = {
  name: string;
  status: ProjectStatus;
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
  | { id: string; kind: 'result'; render: () => ReactNode };

export type DemoScenario = {
  id: string;
  prompt: string;
  sessionName: string;
  thinkingLabel: string;
  /** Skill names from the Skills catalog invoked during this scenario. */
  skills?: string[];
  steps: DemoStep[];
};
