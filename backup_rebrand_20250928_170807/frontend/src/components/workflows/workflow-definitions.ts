import { FileText, Terminal, Rocket, Computer, Eye, Search, Globe, GitBranch, Settings, MonitorPlay, Cog, Key, Presentation, FileOutput, Table2 } from 'lucide-react';
export interface StepDefinition {
    id: string;
    name: string;
    description: string;
    icon: any;
    category: string;
    color: string;
    config?: Record<string, any>;
}

export interface CategoryDefinition {
    id: string;
    name: string;
    description: string;
}

// Tool icon mapping
export const TOOL_ICONS: Record<string, any> = {
    'sb_files_tool': FileText,
    'sb_shell_tool': Terminal,
    'sb_deploy_tool': Rocket,
    'sb_expose_tool': Computer,
    'sb_vision_tool': Eye,
    'browser_tool': MonitorPlay,
    'web_search_tool': Search,
    'data_providers_tool': Globe,
    'sb_presentation_outline_tool': FileOutput,
    'sb_presentation_tool': Presentation,
    'sb_sheets_tool': Table2,
};

// Tool color mapping
export const TOOL_COLORS: Record<string, string> = {
    'sb_files_tool': 'from-blue-500/20 to-blue-600/10 border-blue-500/20 text-blue-500',
    'sb_shell_tool': 'from-purple-500/20 to-purple-600/10 border-purple-500/20 text-purple-500',
    'sb_deploy_tool': 'from-orange-500/20 to-orange-600/10 border-orange-500/20 text-orange-500',
    'sb_expose_tool': 'from-green-500/20 to-green-600/10 border-green-500/20 text-green-500',
    'sb_vision_tool': 'from-blue-500/20 to-blue-600/10 border-blue-500/20 text-blue-500',
    'browser_tool': 'from-purple-500/20 to-purple-600/10 border-purple-500/20 text-purple-500',
    'web_search_tool': 'from-blue-500/20 to-blue-600/10 border-blue-500/20 text-blue-500',
    'data_providers_tool': 'from-blue-500/20 to-blue-600/10 border-blue-500/20 text-blue-500',
    'sb_presentation_outline_tool': 'from-purple-500/20 to-purple-600/10 border-purple-500/20 text-purple-500',
    'sb_presentation_tool': 'from-violet-500/20 to-violet-600/10 border-violet-500/20 text-violet-500',
    'sb_sheets_tool': 'from-purple-500/20 to-purple-600/10 border-purple-500/20 text-purple-500',
};

// Action icon mapping
export const ACTION_ICONS: Record<string, any> = {
    'FileText': FileText,
    'GitBranch': GitBranch,
    'Cog': Cog,
    'Key': Key,
    'Globe': Globe,
    'Settings': Settings,
};

// Base step definitions
export const BASE_STEP_DEFINITIONS: StepDefinition[] = [
    {
        id: 'instruction',
        name: 'Instruction',
        description: 'Add a custom instruction step',
        icon: FileText,
        category: 'actions',
        color: 'from-gray-500/20 to-gray-600/10 border-gray-500/20 text-gray-500'
    },
    // {
    //     id: 'sequence',
    //     name: 'Sequence',
    //     description: 'Group multiple steps together',
    //     icon: GitBranch,
    //     category: 'actions',
    //     color: 'from-gray-500/20 to-gray-600/10 border-gray-500/20 text-gray-500'
    // },
    {
        id: 'condition',
        name: 'If/Then',
        description: 'Add conditional logic',
        icon: Settings,
        category: 'conditions',
        color: 'from-orange-500/20 to-orange-600/10 border-orange-500/20 text-orange-500'
    },
    {
        id: 'mcp_configuration',
        name: 'Add Custom MCP',
        description: 'Configure MCP server connections and settings',
        icon: Cog,
        category: 'configuration',
        color: 'from-indigo-500/20 to-indigo-600/10 border-indigo-500/20 text-indigo-500',
        config: { step_type: 'mcp_configuration' }
    },
    {
        id: 'credentials_profile',
        name: 'Browse Apps',
        description: 'Select and configure credential profiles for authentication',
        icon: Globe,
        category: 'configuration',
        color: 'from-emerald-500/20 to-emerald-600/10 border-emerald-500/20 text-emerald-500',
        config: { step_type: 'credentials_profile' }
    },
];

// Category definitions
export const CATEGORY_DEFINITIONS: CategoryDefinition[] = [
    {
        id: 'actions',
        name: 'Actions',
        description: 'Execute tasks and operations'
    },
    {
        id: 'conditions',
        name: 'Conditions',
        description: 'Add logic and branching'
    },
    {
        id: 'configuration',
        name: 'Configuration',
        description: 'Setup and configure services'
    },
    {
        id: 'integrations',
        name: 'Integrations',
        description: 'Connect to external services and APIs'
    },
    {
        id: 'tools',
        name: 'Tools',
        description: 'Use specific tools and integrations'
    }
];

export function getToolDefinition(toolName: string): StepDefinition | null {
    if (!TOOL_ICONS[toolName]) return null;
    
    return {
        id: `tool_${toolName}`,
        name: toolName.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        description: `Use ${toolName.replace(/_/g, ' ')}`,
        icon: TOOL_ICONS[toolName],
        category: 'tools',
        color: TOOL_COLORS[toolName] || 'from-blue-500/20 to-blue-600/10 border-blue-500/20 text-blue-500',
        config: { tool_name: toolName, tool_type: 'agentpress' }
    };
}

// Helper function to get step definition by ID
export function getStepDefinition(stepId: string): StepDefinition | null {
    const baseStep = BASE_STEP_DEFINITIONS.find(step => step.id === stepId);
    if (baseStep) return baseStep;
    
    // Check if it's a tool
    if (stepId.startsWith('tool_')) {
        const toolName = stepId.replace('tool_', '');
        return getToolDefinition(toolName);
    }
    
    return null;
}

// Helper function to get icon and color for any step
export function getStepIconAndColor(stepType: any): { icon: any; color: string } {
    if (stepType.category === 'tools') {
        const toolName = stepType.config?.tool_name;
        const icon = TOOL_ICONS[toolName] || FileText;
        const color = TOOL_COLORS[toolName] || 'from-blue-500/20 to-blue-600/10 border-blue-500/20 text-blue-500';
        return { icon, color };
    } else if (stepType.category === 'integrations') {
        const toolName = stepType.config?.tool_name;
        // Use more appropriate icons for different integration types
        let icon = FileText; // Default icon for integrations
                  if (toolName?.includes('composio')) {
            icon = Globe;
        } else if (toolName?.includes('mcp')) {
            icon = Cog;
        }
        const color = 'from-purple-500/20 to-purple-600/10 border-purple-500/20 text-purple-500';
        return { icon, color };
    } else if (stepType.category === 'conditions') {
        return { icon: Settings, color: 'from-orange-500/20 to-orange-600/10 border-orange-500/20 text-orange-500' };
    } else if (stepType.category === 'configuration') {
        const stepType_id = stepType.config?.step_type || stepType.id;
        if (stepType_id === 'mcp_configuration') {
            return { icon: Cog, color: 'from-indigo-500/20 to-indigo-600/10 border-indigo-500/20 text-indigo-500' };
        } else if (stepType_id === 'credentials_profile') {
            return { icon: Key, color: 'from-emerald-500/20 to-emerald-600/10 border-emerald-500/20 text-emerald-500' };
        }
        return { icon: Cog, color: 'from-indigo-500/20 to-indigo-600/10 border-indigo-500/20 text-indigo-500' };
    } else {
        const icon = ACTION_ICONS[stepType.icon] || FileText;
        return { icon, color: 'from-gray-500/20 to-gray-600/10 border-gray-500/20 text-gray-500' };
    }
}

// Helper function to generate available step types from agent tools
export function generateAvailableStepTypes(agentTools?: {
    agentpress_tools: Array<{ name: string; description: string; icon?: string; enabled: boolean }>;
    mcp_tools: Array<{ name: string; description: string; icon?: string; server?: string }>;
}): StepDefinition[] {
    const allSteps = [...BASE_STEP_DEFINITIONS];

    // Add AgentPress tools
    if (agentTools?.agentpress_tools) {
        agentTools.agentpress_tools.forEach(tool => {
            if (tool.enabled) {
                const toolDef = getToolDefinition(tool.name);
                if (toolDef) {
                    allSteps.push({
                        ...toolDef,
                        description: tool.description
                    });
                }
            }
        });
    }

    // Add MCP tools to integrations category
    if (agentTools?.mcp_tools) {
        agentTools.mcp_tools.forEach(tool => {
            allSteps.push({
                id: `mcp_${tool.name}`,
                name: tool.name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
                description: tool.description,
                icon: Cog, // Better icon for MCP tools
                category: 'integrations',
                color: 'from-purple-500/20 to-purple-600/10 border-purple-500/20 text-purple-500',
                config: { tool_name: tool.name, tool_type: 'mcp', server: tool.server }
            });
        });
    }

    return allSteps;
} 