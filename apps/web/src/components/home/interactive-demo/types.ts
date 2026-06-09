import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { IconType } from 'react-icons/lib';

export type PageId =
  | 'home'
  | 'chat'
  | 'agents'
  | 'skills'
  | 'integrations'
  | 'models'
  | 'scheduling'
  | 'channels'
  | 'security';

export type Nav = (id: PageId) => void;

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
  steps: DemoStep[];
};
