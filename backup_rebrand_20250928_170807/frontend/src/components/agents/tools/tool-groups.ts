export interface ToolMethod {
  name: string;
  displayName: string;
  description: string;
  enabled: boolean;
  isCore?: boolean;
}

export interface ToolGroup {
  name: string;
  displayName: string;
  description: string;
  icon: string;
  color: string;
  toolClass: string;
  methods: ToolMethod[];
  enabled: boolean;
  isCore?: boolean;
}

import { TOOL_GROUPS as COMPREHENSIVE_TOOL_GROUPS } from './tool-groups-comprehensive';

export const TOOL_GROUPS: Record<string, ToolGroup> = COMPREHENSIVE_TOOL_GROUPS;

export { 
  getToolGroup, 
  getAllToolGroups, 
  hasGranularControl, 
  getEnabledMethodsForTool, 
  validateToolConfig, 
  convertLegacyToolConfig 
} from './tool-groups-comprehensive';
