import { Project } from "@/lib/api";

export interface ToolViewProps {
  assistantContent?: string;
  toolContent?: string;
  assistantTimestamp?: string;
  toolTimestamp?: string;
  isSuccess?: boolean;
  project?: Project;
}

export interface BrowserToolViewProps extends ToolViewProps {
  name?: string;
} 