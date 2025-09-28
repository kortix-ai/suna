import { Project } from '@/lib/api';

export interface ToolViewProps {
  assistantContent?: string;
  toolContent?: string;
  assistantTimestamp?: string;
  toolTimestamp?: string;
  isSuccess?: boolean;
  isStreaming?: boolean;
  project?: Project;
  name?: string;
  messages?: any[];
  agentStatus?: string;
  currentIndex?: number;
  totalCalls?: number;
  onFileClick?: (filePath: string) => void;
  viewToggle?: React.ReactNode;
}

export interface BrowserToolViewProps extends ToolViewProps {
  name?: string;
}
